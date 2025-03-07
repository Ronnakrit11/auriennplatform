import { NextResponse } from 'next/server';
import { db } from '@/lib/db/drizzle';
import { userBalances, users, depositLimits, paymentTransactions } from '@/lib/db/schema';
import { eq, and, sql, gte } from 'drizzle-orm';
import { getUser } from '@/lib/db/queries';
import { sendDepositNotification } from '@/lib/telegram/bot';

const API_URL = 'https://developer.easyslip.com/api/v1/verify';
const API_KEY = process.env.EASYSLIP_API_KEY;

const EXPECTED_RECEIVER = {
  name: {
    th: "บจก. เอ็กซ์เพิร์ท เ",
    en: "EXPERT 8"
  },
  account: "XXX-X-XX730-5",
  type: "BANKAC"
};

if (!API_KEY) {
  throw new Error('EASYSLIP_API_KEY not configured');
}

// Define response type according to EasySlip API
type EasySlipResponse = {
  status: number;
  data?: {
    payload: string;
    transRef: string;
    date: string;
    countryCode: string;
    amount: {
      amount: number;
      local: {
        amount?: number;
        currency?: string;
      };
    };
    fee?: number;
    ref1?: string;
    ref2?: string;
    ref3?: string;
    sender: {
      bank: {
        id: string;
        name?: string;
        short?: string;
      };
      account: {
        name: {
          th?: string;
          en?: string;
        };
        bank?: {
          type: 'BANKAC' | 'TOKEN' | 'DUMMY';
          account: string;
        };
        proxy?: {
          type: 'NATID' | 'MSISDN' | 'EWALLETID' | 'EMAIL' | 'BILLERID';
          account: string;
        };
      };
    };
    receiver: {
      bank: {
        id: string;
        name?: string;
        short?: string;
      };
      account: {
        name: {
          th?: string;
          en?: string;
        };
        bank?: {
          type: 'BANKAC' | 'TOKEN' | 'DUMMY';
          account: string;
        };
        proxy?: {
          type: 'NATID' | 'MSISDN' | 'EWALLETID' | 'EMAIL' | 'BILLERID';
          account: string;
        };
      };
      merchantId?: string;
    };
  };
  message?: string;
}

function validateReceiver(data: EasySlipResponse): boolean {
  if (!data.data?.receiver?.account) {
    return false;
  }

  const receiver = data.data.receiver.account;

  // Check receiver name (both Thai and English)
  if (receiver.name?.th !== EXPECTED_RECEIVER.name.th || 
      receiver.name?.en !== EXPECTED_RECEIVER.name.en) {
    return false;
  }

  // Check bank account type and number
  if (receiver.bank?.type !== EXPECTED_RECEIVER.type || 
      receiver.bank?.account !== EXPECTED_RECEIVER.account) {
    return false;
  }

  return true;
}

async function checkSlipAlreadyUsed(transRef: string): Promise<boolean> {
  const existingSlip = await db
    .select()
    .from(paymentTransactions)
    .where(eq(paymentTransactions.transRef, transRef))
    .limit(1);

  return existingSlip.length > 0;
}

async function checkDepositLimits(userId: number, amount: number): Promise<{ allowed: boolean; message?: string }> {
  // Get user's deposit limit
  const [user] = await db
    .select({
      depositLimit: depositLimits
    })
    .from(users)
    .leftJoin(depositLimits, eq(users.depositLimitId, depositLimits.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (!user.depositLimit) {
    return { allowed: false, message: 'No deposit limit set for user' };
  }

  // Get today's total deposits
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [dailyTotal] = await db
    .select({
      total: sql<string>`COALESCE(sum(${paymentTransactions.amount}), '0')`
    })
    .from(paymentTransactions)
    .where(
      and(
        eq(paymentTransactions.userId, userId),
        gte(paymentTransactions.createdAt, today)
      )
    );

  const dailyTotalAmount = Number(dailyTotal.total);
  const newDailyTotal = dailyTotalAmount + amount;
  const dailyLimit = Number(user.depositLimit.dailyLimit);

  if (newDailyTotal > dailyLimit) {
    return { 
      allowed: false, 
      message: `Deposit would exceed daily limit of ฿${dailyLimit.toLocaleString()}`
    };
  }

  return { allowed: true };
}

async function recordVerifiedSlip(transRef: string, amount: number, userId: number | null) {
  if (!userId) {
    throw new Error('User ID is required');
  }

  await db.transaction(async (tx) => {
    // Record the verified slip
    await tx.insert(paymentTransactions).values({
      status: 'CP',
      statusName: 'ชำระเงินสำเร็จ',
      total: amount.toString(),
      amount: amount.toString(),
      userId: userId,
      method: 'BANK',
      transRef: transRef,
      merchantId: '',
      orderNo: transRef,
      refNo: transRef,
      productDetail: 'เติมเงินผ่านการโอนเงิน',
      createdAt: new Date(),
      updatedAt: new Date(),
      paymentDate: new Date(),
    });

    // Update user balance
    await tx
      .update(userBalances)
      .set({
        balance: sql`${userBalances.balance} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(userBalances.userId, userId));
  });
}

export async function POST(request: Request) {
  try {
    const user = await getUser();
    const formData = await request.formData();
    const file = formData.get('slip') as File;

    if (!file) {
      return NextResponse.json(
        { status: 400, message: 'invalid_payload' },
        { status: 400 }
      );
    }

    // Check file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { status: 400, message: 'image_size_too_large' },
        { status: 400 }
      );
    }

    // Check file type
    if (!file.type.startsWith('image/')) {
      return NextResponse.json(
        { status: 400, message: 'invalid_image' },
        { status: 400 }
      );
    }

    // Convert file to base64
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const base64 = buffer.toString('base64');

    // Call EasySlip API
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        image: base64
      }),
      cache: 'no-store',
    });

    if (!response.ok) {
      console.error('EasySlip API error:', await response.text());
      return NextResponse.json(
        { status: 400, message: 'invalid_slip' },
        { status: 400 }
      );
    }

    const data: EasySlipResponse = await response.json();

    // Handle different response statuses
    if (!data.data) {
      return NextResponse.json(
        { status: 400, message: 'invalid_slip', details: data.message },
        { status: 400 }
      );
    }

    // Validate receiver information
    if (!validateReceiver(data)) {
      return NextResponse.json(
        { 
          status: 400, 
          message: 'invalid_receiver',
          details: 'Transfer must be to the correct account only'
        },
        { status: 400 }
      );
    }

    // Check if slip has already been used
    if (data.data?.transRef) {
      const isUsed = await checkSlipAlreadyUsed(data.data.transRef);
      if (isUsed) {
        return NextResponse.json(
          {
            status: 400,
            message: 'slip_already_used',
            details: 'This transfer slip has already been used'
          },
          { status: 400 }
        );
      }

      // Check deposit limits if user is logged in
      if (user) {
        const depositCheck = await checkDepositLimits(user.id, data.data.amount.amount);
        if (!depositCheck.allowed) {
          return NextResponse.json(
            {
              status: 400,
              message: 'deposit_limit_exceeded',
              details: depositCheck.message
            },
            { status: 400 }
          );
        }
      }

      // Record the verified slip and update user balance
      await recordVerifiedSlip(
        data.data.transRef,
        data.data.amount.amount,
        user?.id || null
      );

      // Send Telegram notification
      if (user) {
        await sendDepositNotification({
          userName: user.name || user.email,
          amount: data.data.amount.amount,
          transRef: data.data.transRef
        });
      }
    }

    return NextResponse.json({ status: 200, message: 'success' });
  } catch (error) {
    console.error('Error verifying slip:', error);
    return NextResponse.json(
      { status: 500, message: 'server_error' },
      { status: 500 }
    );
  }
}