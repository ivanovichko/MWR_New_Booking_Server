const { JSDOM } = require('jsdom');
const { taPost } = require('./taAuthService');

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

  // ── Customer ID — extracted from either link (used for /user/:id/reservations) ──
  const idMatch = (loginLink && loginLink.match(/webadminCustomerLogin\/(\d+)/)) ||
                  (profileLink && profileLink.match(/viewCustomer\/(\d+)/));
  const id = idMatch ? idMatch[1] : null;

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
    id,
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

/**
 * Searches TravelAdvantage for primary and secondary members matching the query.
 * Returns a merged, deduplicated array of user objects.
 */
async function findUser(query) {
  const primaryParams = (searchValue) => {
    const p = new URLSearchParams({
      draw: '1', start: '0', length: '10',
      'order[0][column]': '1', 'order[0][dir]': 'desc',
      'search[value]': searchValue, 'search[regex]': 'false',
    });
    const nonOrderable = [0, 8, 9, 10, 12, 14];
    for (let i = 0; i < 15; i++) {
      p.append(`columns[${i}][data]`, i.toString());
      p.append(`columns[${i}][name]`, '');
      p.append(`columns[${i}][searchable]`, 'true');
      p.append(`columns[${i}][orderable]`, nonOrderable.includes(i) ? 'false' : 'true');
      p.append(`columns[${i}][search][value]`, '');
      p.append(`columns[${i}][search][regex]`, 'false');
    }
    return p.toString();
  };

  const secondaryParams = new URLSearchParams({
    draw: '1', start: '0', length: '10',
    'order[0][column]': '1', 'order[0][dir]': 'desc',
    'search[value]': query, 'search[regex]': 'false',
  });
  for (let i = 0; i < 10; i++) {
    secondaryParams.append(`columns[${i}][data]`, i.toString());
    secondaryParams.append(`columns[${i}][name]`, '');
    secondaryParams.append(`columns[${i}][searchable]`, 'true');
    secondaryParams.append(`columns[${i}][orderable]`, (i === 0 || i === 9) ? 'false' : 'true');
    secondaryParams.append(`columns[${i}][search][value]`, '');
    secondaryParams.append(`columns[${i}][search][regex]`, 'false');
  }

  const primaryUrl = `https://traveladvantage.com/admin/account/customersList/All/All/null/null/All/All/${query.replace(/\//g, '%2F')}`;
  const [primaryRes, secondaryRes] = await Promise.all([
    taPost(primaryUrl, primaryParams(''), { 'Referer': 'https://traveladvantage.com/admin/account/manageCustomers' }),
    taPost('https://traveladvantage.com/admin/account/travelersList', secondaryParams.toString(), { 'Referer': 'https://traveladvantage.com/admin/account/manageTravelers' }),
  ]);

  const strip = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const extractCustomerId = (cell) => { const m = (cell || '').match(/viewCustomer\/(\d+)/); return m ? m[1] : null; };
  const extractTravelerId = (cell) => { const m = (cell || '').match(/editTraveler\((\d+)\)/); return m ? m[1] : null; };

  const primary = (primaryRes.data || []).map(row => ({
    type:     'primary',
    id:       extractCustomerId(row[0]),
    name:     strip(row[2]),
    memberId: strip(row[3]),
    instance: strip(row[4]),
    email:    strip(row[5]),
    phone:    strip(row[6]),
    country:  strip(row[7]),
    status:   strip(row[11]),
  })).filter(u => u.id);

  const secondary = (secondaryRes.data || []).map(row => ({
    type:          'secondary',
    id:            extractTravelerId(row[0]),
    name:          strip(row[2]),
    primaryMember: strip(row[3]),
    instance:      strip(row[4]),
    email:         strip(row[5]),
    phone:         strip(row[6]),
    status:        strip(row[7]),
  })).filter(u => u.id);

  return [...primary, ...secondary];
}

module.exports = { parseUserHtml, findUser };
