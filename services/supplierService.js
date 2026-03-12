/**
 * Supplier contact lookup.
 * Returns primary email (or contact URL) and any critical notes for the note.
 * Standalone and reusable.
 */

const SUPPLIER_MAP = [
  {
    names: ['agoda'],
    email: 'cs_partners@agoda.com',
    note: 'See internal notes for required subject line and email content format.',
  },
  {
    names: ['bookopro', 'booko'],
    email: null,
    contactUrl: 'https://bookoteam.com/',
    note: 'Contact via bookoteam.com. For agency company name enter: MWR Life. Emergencies only (client at destination): contact our lines after creating a case.',
  },
  {
    names: ['cartrawler'],
    email: 'partners@cartrawler.com',
  },
  {
    names: ['expedia'],
    email: 'A2Alatam.es@chat.expediapartnersolutions.com',
  },
  {
    names: ['gettransfer', 'get transfer'],
    email: 'b2bsupport@gettransfer.com',
    note: 'CC: info@gettransfer.com. Online chat also available on their site.',
  },
  {
    names: ['goglobal', 'go global', 'olympiaeurope', 'olympia europe'],
    email: 'fitus@goglobal.travel',
    note: 'Emergency 24/7: same email. Use subject URGENT/ON SPOT + booking # e.g. "URGENT - GO19760653-21378032-A(US)"',
  },
  {
    names: ['happytravel', 'happy travel'],
    email: 'Reservations@happytravel.com',
    note: 'Urgent/On Spot only — 24/7 ONLY while guest is at destination.',
  },
  {
    names: ['hotelbeds', 'hotel beds'],
    email: 'americas.english@hotelbeds.com',
    note: 'Post-travel: complaints.americas.english@hotelbeds.com. For post-travel, prefer asking 2nd level to open a ticket on their site.',
  },
  {
    names: ['methabook'],
    email: 'customerservice@methabook.com',
    note: 'Same-day arrivals: emergencies@methabook.com. Hotel conf. numbers: hcn@methabook.com. Past bookings: complaints@methabook.com.',
  },
  {
    names: ['paximum'],
    email: 'sales@paximum.com',
    note: 'CC: aysun.kotanak@paximum.com, accounts@paximum.com, ticket@paximum.com for booking/pre-arrival/on-spot/post-checkout issues.',
  },
  {
    names: ['pkfare', 'pk fare'],
    email: 'aftersale@pkfare.com',
    note: 'CC: cs.vip@pkfare.co and pkfare.vip@pkfare.com. Real emergency (no chat): pkfare.vip@pkfare.com — also CC Annmarie, Audrey, Patricia @mwrlife.com.',
  },
  {
    names: ['priceline'],
    email: 'hotel@cs.travelweb.com',
    note: 'Subject line: <Hotel>, <Trip Confirmation Number>, <Brief Issue>. CC Eve Del Rosario and Patricia@mwrlife.com.',
  },
  {
    names: ['qunar'],
    email: 'guojihaiwaifenxiao@qunar.com',
    note: 'Notify 2nd level to also report in Skype chat. Any action (cancellation, change, modification) — email first, then Skype.',
  },
  {
    names: ['ratehawk', 'rate hawk'],
    email: 'support@ratehawk.com',
  },
  {
    names: ['rci'],
    email: '#EVROps@rci.com',
    note: 'CC: wholesale.bp@rci.com. Include our account number when contacting.',
  },
  {
    names: ['restel'],
    email: 'booking@restel.global',
    note: 'Post-travel: booking@restel.global. Include supplier reservation number in subject line.',
  },
  {
    names: ['talixo'],
    email: 'support@talixo.com',
    note: '4–8 hour response. Self-service chat: talixo.com/self-service/login. Post-travel complaints: complaints@talixo.com.',
  },
  {
    names: ['tbo'],
    email: 'ops.me@tbo.com',
  },
  {
    names: ['tictactrip', 'tic tac trip'],
    email: 'care@tictactrip.eu',
    contactUrl: 'https://www.tictactrip.eu/support',
  },
  {
    names: ['viator'],
    email: 'dpsupport@viator.com',
  },
  {
    names: ['w2m'],
    email: 'booking.requests@w2m.com',
    note: 'Subject: W2M booking reference ONLY. On-spot: inresort@w2m.com. Complaints: complaints@w2m.com. Cancellation waiver: cxlwaiver@w2m.com. Use only ONE contact email per request.',
  },
  {
    names: ['webbeds', 'web beds'],
    email: 'USA-Customerservice@WebBeds.com',
    note: 'In-resort: Inresort@webbeds.com. More contacts: webbeds.com/contact-global-cs/',
  },
  {
    names: ['withinearth', 'within earth'],
    email: 'support@withinearth.com',
    note: 'CC: ops@withinearth.com. 24/7 online chat via b2b.withinearth.com (ask 2nd level/mgmt).',
  },
];

/**
 * Normalise a supplier name for fuzzy matching.
 */
function normalise(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Look up supplier contact info by name.
 * @param {string} supplierName - as it appears in DataTables
 * @returns {{ email, contactUrl, note } | null}
 */
function lookupSupplier(supplierName) {
  const key = normalise(supplierName);
  if (!key) return null;

  for (const entry of SUPPLIER_MAP) {
    if (entry.names.some(n => normalise(n) === key || key.includes(normalise(n)) || normalise(n).includes(key))) {
      return {
        email:      entry.email      || null,
        contactUrl: entry.contactUrl || null,
        note:       entry.note       || null,
      };
    }
  }
  return null;
}

module.exports = { lookupSupplier };
