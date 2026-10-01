import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Ctx } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { many, maybeOne, one } from '../../lib/db.js';
import { formatIST } from '../../lib/time.js';
import { netCaptured } from './settlement.js';

// Standard PDF fonts cannot draw ₹, so amounts are shown as "Rs." (production should embed a Unicode font).
const rs = (paise: number) => `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ascii = (s: string) => s.replace(/[^\x20-\x7E]/g, '?');

const TARGET_TITLE: Record<string, string> = {
  pharmacy_order: 'Medicines',
  equipment_rental: 'Equipment rental',
  ambulance_run: 'Ambulance',
};

/** Receipt PDF for an invoice, generated once on first download and kept in private storage. */
export async function invoicePdfUrl(ctx: Ctx, userId: string, invoiceId: string) {
  const inv = await maybeOne(ctx.db, 'SELECT * FROM invoices WHERE id=$1 AND user_id=$2', [invoiceId, userId]);
  if (!inv) throw new AppError('NOT_FOUND', 'Invoice not found');
  let key = inv.pdf_key as string | null;
  if (!key) {
    key = `invoices/${userId}/${inv.id}.pdf`;
    await ctx.adapters.storage.put(key, await renderInvoice(ctx, inv), 'application/pdf');
    await ctx.db.query('UPDATE invoices SET pdf_key=$2 WHERE id=$1 AND pdf_key IS NULL', [inv.id, key]);
  }
  return { invoice_id: inv.id, number: inv.number, url: await ctx.adapters.storage.presignGet(key, 300), expires_in: 300 };
}

async function renderInvoice(ctx: Ctx, inv: any): Promise<Buffer> {
  const user = await one(ctx.db, 'SELECT name, phone_e164 FROM users WHERE id=$1', [inv.user_id]);
  let title = TARGET_TITLE[inv.target_type] ?? 'Service';
  let patientName: string | null = null;
  if (inv.target_type === 'service_request') {
    const sr = await one(ctx.db, 'SELECT s.name, p.name AS patient FROM service_requests sr JOIN services s ON s.code=sr.service_code JOIN patients p ON p.id=sr.patient_id WHERE sr.id=$1', [inv.target_id]);
    title = sr.name;
    patientName = sr.patient;
  }
  const paid = await netCaptured(ctx.db, inv.target_type, inv.target_id);
  const refunds = await many(
    ctx.db,
    `SELECT r.amount_paise, r.status FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.target_type=$1 AND p.target_id=$2 AND r.status <> 'failed'`,
    [inv.target_type, inv.target_id],
  );
  const refunded = refunds.reduce((s, r) => s + r.amount_paise, 0);

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const text = (s: string, x: number, size = 10, f = font) => page.drawText(ascii(s), { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  const row = (left: string, right: string, f = font, size = 10) => {
    text(left, 48, size, f);
    const w = f.widthOfTextAtSize(ascii(right), size);
    text(right, 547 - w, size, f);
    y -= size + 8;
  };

  text('KM DocH - Doctor At Your Home', 48, 16, bold);
  y -= 26;
  row('Receipt', inv.number, bold, 12);
  row('Date', `${formatIST(new Date(inv.issued_at))} IST`);
  row('Billed to', `${user.name ?? 'Customer'} (${user.phone_e164.slice(0, 3)}******${user.phone_e164.slice(-4)})`);
  if (patientName) row('Patient', patientName);
  row('For', title);
  y -= 10;
  page.drawLine({ start: { x: 48, y: y + 6 }, end: { x: 547, y: y + 6 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  y -= 8;
  for (const l of inv.line_items as any[]) {
    const name = l.name ?? l.code;
    const qty = l.qty && l.qty !== 1 ? ` x ${l.qty}` : '';
    row(`${name}${qty}`, rs(l.amount_paise ?? 0));
    if (l.note) {
      text(l.note, 60, 8);
      y -= 14;
    }
  }
  page.drawLine({ start: { x: 48, y: y + 6 }, end: { x: 547, y: y + 6 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  y -= 8;
  row('Total', rs(inv.total_paise), bold, 11);
  if (paid + refunded > 0) row('Paid', rs(paid + refunded));
  if (refunded > 0) row('Refunded', rs(refunded));
  row('Balance due', rs(Math.max(0, inv.total_paise - paid)), bold, 11);
  y = 90;
  text('KM DocH is a mediator. Diagnosis and prescriptions are the responsibility of the treating doctor.', 48, 8);
  y -= 12;
  text('Tax details (GSTIN, SAC codes) to be added once confirmed by the business.', 48, 8);
  return Buffer.from(await pdf.save());
}
