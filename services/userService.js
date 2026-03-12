const { JSDOM } = require('jsdom');

/**
 * Parses the TravelAdvantage user profile page HTML.
 * Standalone and reusable — can be called from any endpoint.
 * Returns structured user object.
 */
function parseUserHtml(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // ── Helper: find value next to a label text ──────────────────────────────
  const getValue = (labelText) => {
    const labels = [...doc.querySelectorAll('label')];
    const label = labels.find(l =>
      l.textContent.trim().toLowerCase().startsWith(labelText.toLowerCase())
    );
    if (!label) return null;

    // Value is in the next sibling div (same .row structure)
    const row = label.closest('.row');
    if (!row) return null;

    // Find a div in this row that isn't the label's parent and has text
    const valueDivs = [...row.querySelectorAll('div')].filter(div =>
      div !== label.parentElement &&
      !div.querySelector('label') &&
      div.textContent.trim()
    );

    const raw = valueDivs[0]?.textContent?.trim().replace(/\s+/g, ' ') || null;
    return raw === '-' || raw === '' ? null : raw;
  };

  // ── Top header fields (already rendered by existing script) ──────────────
  // These come from the header above the grid, not from the label/value pairs
  const nameEl    = doc.querySelector('.ta-card strong') ||
                    doc.querySelector('[class*="member"] strong');

  // ── Profile grid fields ───────────────────────────────────────────────────
  const firstName  = getValue('First Name');
  const lastName   = getValue('Last Name');
  const fullName   = [firstName, lastName].filter(Boolean).join(' ') || null;
  const email      = getValue('Email');
  const phone      = getValue('Phone Number');
  const dob        = getValue('Date of Birth');
  const status     = getValue('Status') ||
                     doc.querySelector('.badge-success, .badge-danger')?.textContent?.trim() || null;
  const country    = getValue('Country');
  const state      = getValue('State or Province');
  const city       = getValue('City');
  const nationality = getValue('Nationality');
  const address1   = getValue('Address 1');
  const zip        = getValue('ZIP / Postal Code');
  const turbo      = getValue('Turbo Access');
  const expiry     = getValue('Expiry Date');

  // Instance — has special styling, look for it specifically
  const instanceEl = doc.querySelector('[style*="B687D9"] strong') ||
                     doc.querySelector('[style*="b687d9"] strong');
  const instance   = instanceEl?.textContent?.trim() || getValue('Instance') || null;

  // ── Login as User link ────────────────────────────────────────────────────
  const loginLink = doc.querySelector('a[href*="webadminCustomerLogin"]')?.href || null;

  // ── Open Full Profile link ────────────────────────────────────────────────
  const profileLink = doc.querySelector('a[href*="viewCustomer"]')?.href || null;

  // ── Secondary members ─────────────────────────────────────────────────────
  const secondaryMembers = [];
  doc.querySelectorAll('[id^="body_"]').forEach(memberDiv => {
    const name    = memberDiv.querySelector('label + *')?.nextSibling?.textContent?.trim() || null;
    const nameEl  = [...memberDiv.querySelectorAll('div')].find(d =>
      d.querySelector('label')?.textContent?.includes('Name:')
    );
    const memberName    = nameEl?.textContent?.replace('Name:', '').trim() || null;
    const memberCountry = [...memberDiv.querySelectorAll('div')].find(d =>
      d.querySelector('label')?.textContent?.includes('Country:')
    )?.textContent?.replace('Country:', '').trim() || null;
    const memberStatus  = memberDiv.querySelector('.badge')?.textContent?.trim() || null;

    if (memberName) {
      secondaryMembers.push({ name: memberName, country: memberCountry, status: memberStatus });
    }
  });

  return {
    fullName,
    firstName,
    lastName,
    email,
    phone,
    dob,
    status,
    country,
    state,
    city,
    nationality,
    address1,
    zip,
    instance,
    turbo,
    expiry,
    loginLink,
    profileLink,
    secondaryMembers,
  };
}

module.exports = { parseUserHtml };
