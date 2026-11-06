// Invoice (challan) tracking: alerts on newly issued unpaid challans and
// reminds before a due date passes.

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');

// Columns are matched by header name so a reordered table does not break this.
export function parseInvoices(snapshot) {
  const tables = snapshot?.global?.invoices;
  if (!Array.isArray(tables)) return [];

  const out = [];
  for (const t of tables) {
    const col = (want) => (t.columns ?? []).findIndex((c) => norm(c) === norm(want));
    const idx = {
      invoiceDate: col('Invoice Date'), dueDate: col('Due Date'), term: col('Term'),
      type: col('Challan Type'), id: col('Challan ID'), amount: col('Payable Amount'),
      status: col('Status'), paidDate: col('Paid Date'),
    };
    if (idx.status < 0 || idx.id < 0) continue;

    for (const row of t.rows ?? []) {
      const pick = (i) => (i >= 0 ? (row[i] ?? '').trim() : '');
      const amount = Number(pick(idx.amount).replace(/,/g, '')) || 0;
      out.push({
        id: pick(idx.id), term: pick(idx.term), type: pick(idx.type),
        invoiceDate: pick(idx.invoiceDate), dueDate: pick(idx.dueDate),
        amount, status: pick(idx.status), paidDate: pick(idx.paidDate),
        paid: /^paid$/i.test(pick(idx.status)),
      });
    }
  }
  return out;
}

export const unpaid = (snapshot) => parseInvoices(snapshot).filter((i) => !i.paid && i.amount > 0);

const money = (n) => `Rs ${n.toLocaleString('en-PK')}`;

export function diffInvoices(prev, next) {
  const before = new Map(parseInvoices(prev).map((i) => [i.id, i]));
  const events = [];

  for (const inv of parseInvoices(next)) {
    const old = before.get(inv.id);

    if (!old && !inv.paid && inv.amount > 0) {
      events.push({
        kind: 'invoice', priority: 1,
        text: `[unpaid challan] *${inv.type || 'Challan'}* ${inv.term}\n`
            + `${money(inv.amount)} due ${inv.dueDate}\nChallan ID: ${inv.id}`,
      });
    } else if (old && !old.paid && !inv.paid && old.amount !== inv.amount && inv.amount > 0) {
      events.push({
        kind: 'invoice', priority: 1,
        text: `[challan changed] *${inv.type}* ${inv.term}\n${money(old.amount)} -> ${money(inv.amount)}, due ${inv.dueDate}`,
      });
    }
  }
  return events;
}

// Reminders at a fixed set of days before the due date, so one challan
// produces a few nudges rather than a daily drip.
export function invoiceReminders(snapshot, todayStr, offsets = [7, 3, 1, 0]) {
  const today = Date.parse(`${todayStr}T00:00:00+05:00`);
  const out = [];

  for (const inv of unpaid(snapshot)) {
    const due = Date.parse(`${inv.dueDate}T00:00:00+05:00`);
    if (Number.isNaN(due)) continue;
    const days = Math.round((due - today) / 864e5);

    if (days < 0) {
      out.push({ kind: 'invoice-overdue', days, text: `[OVERDUE] *${inv.type}* ${money(inv.amount)}\nDue ${inv.dueDate} (${-days} days ago). Challan ${inv.id}` });
    } else if (offsets.includes(days)) {
      const when = days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`;
      out.push({ kind: 'invoice-due', days, text: `[challan due ${when}] *${inv.type}* ${money(inv.amount)}\nDue ${inv.dueDate}. Challan ${inv.id}` });
    }
  }
  return out.sort((a, b) => a.days - b.days);
}
