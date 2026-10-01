import { createHmac, randomUUID } from 'node:crypto';

export interface GatewayOrder {
  gateway: string;
  orderId: string;
  /** What the client needs to open the checkout (UPI intent / card sheet). */
  clientPayload: Record<string, unknown>;
}

export interface PaymentGateway {
  readonly name: string;
  createOrder(amountPaise: number, receipt: string, method: 'upi' | 'card'): Promise<GatewayOrder>;
  refund(paymentId: string, amountPaise: number): Promise<{ refundId: string }>;
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
  fetchPaymentStatus(orderId: string): Promise<'captured' | 'failed' | 'pending'>;
}

/** Deterministic fake gateway for dev/test. `failNext` simulates gateway outages. */
export class FakePaymentGateway implements PaymentGateway {
  readonly name = 'fake';
  failNext = false;
  readonly statuses = new Map<string, 'captured' | 'failed' | 'pending'>();
  constructor(private readonly webhookSecret: string) {}
  async createOrder(amountPaise: number, receipt: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Gateway unavailable');
    }
    const orderId = `order_${randomUUID()}`;
    this.statuses.set(orderId, 'pending');
    return { gateway: this.name, orderId, clientPayload: { order_id: orderId, amount: amountPaise, receipt } };
  }
  /** Number of upcoming refund calls that should fail (simulates gateway outages). */
  failRefunds = 0;
  async refund() {
    if (this.failRefunds > 0) {
      this.failRefunds--;
      throw new Error('Gateway refund unavailable');
    }
    return { refundId: `rfnd_${randomUUID()}` };
  }
  verifyWebhook(rawBody: string, signature: string | undefined) {
    return signature === createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }
  async fetchPaymentStatus(orderId: string) {
    return this.statuses.get(orderId) ?? 'failed';
  }
}

export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay';
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}
  private auth() {
    return 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
  }
  async createOrder(amountPaise: number, receipt: string, method: 'upi' | 'card') {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { authorization: this.auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt, notes: { method } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Razorpay order failed: ${res.status}`);
    const o = (await res.json()) as { id: string };
    return { gateway: this.name, orderId: o.id, clientPayload: { key_id: this.keyId, order_id: o.id, amount: amountPaise } };
  }
  async refund(paymentId: string, amountPaise: number) {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
      method: 'POST',
      headers: { authorization: this.auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise }),
    });
    if (!res.ok) throw new Error(`Razorpay refund failed: ${res.status}`);
    return { refundId: ((await res.json()) as { id: string }).id };
  }
  verifyWebhook(rawBody: string, signature: string | undefined) {
    return signature === createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }
  async fetchPaymentStatus(orderId: string) {
    const res = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, { headers: { authorization: this.auth() } });
    if (!res.ok) return 'pending';
    const o = (await res.json()) as { status: string };
    return o.status === 'paid' ? 'captured' : o.status === 'attempted' ? 'pending' : 'pending';
  }
}
