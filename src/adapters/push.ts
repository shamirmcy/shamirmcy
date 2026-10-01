export interface PushAdapter {
  send(pushToken: string, title: string, body: string, data?: Record<string, string>): Promise<void>;
}

export class ConsolePushAdapter implements PushAdapter {
  readonly sent: Array<{ token: string; title: string; body: string; data?: Record<string, string> }> = [];
  async send(token: string, title: string, body: string, data?: Record<string, string>) {
    this.sent.push({ token, title, body, data });
  }
}

/** FCM HTTP v1. The access token should come from a workload-identity / service-account refresher. */
export class FcmPushAdapter implements PushAdapter {
  constructor(
    private readonly projectId: string,
    private readonly accessToken: () => Promise<string>,
  ) {}
  async send(token: string, title: string, body: string, data?: Record<string, string>) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token, notification: { title, body }, data } }),
    });
    if (!res.ok) throw new Error(`FCM send failed: ${res.status}`);
  }
}
