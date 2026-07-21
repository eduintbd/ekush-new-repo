// Tax Certificate HTML builder — single source of truth for both the
// investor-facing print page (/forms/tax-certificate) and the admin PDF
// download + bulk-mail attachment. Keeping these in lockstep means design
// tweaks automatically flow everywhere.
//
// Layout matches the AMC's reference letter (A00539): logo top-right, the
// "To Whom It May Concern" body with Opening/Closing balances side-by-side,
// a typed signature, and an orange footer band with a verification QR.
//
// Server (Puppeteer) callers pass logoDataUrl / qrDataUrl as data URIs so
// setContent() needs no network access; the browser print page leaves them
// unset and the public paths resolve directly.

export interface TaxCertificateData {
  // Investor
  investorName: string;
  investorCode: string;
  investorTitle: string | null; // "Mr.", "Ms.", etc.
  investorType?: string | null; // "INDIVIDUAL" | "COMPANY_ORGANIZATION" | …
  nidNumber: string | null;
  tinNumber: string | null;

  // Fund
  fundCode: string;
  fundName: string;

  // Period
  periodStart: Date | null;
  periodEnd: Date | null;

  // Cert figures
  beginningCostValue: number;
  endingCostValue: number;
  beginningMarketValue: number;
  endingMarketValue: number;
  beginningUnrealizedGain: number;
  endingUnrealizedGain: number;
  totalRealizedGain: number;
  totalAdditionAtCost: number;
  totalRedemptionAtCost: number;
  netInvestment: number;
  totalGrossDividend: number;
  totalTax: number;
  totalNetDividend: number;

  // Chalan details (kept in the type for data parity; not rendered in the
  // reference letter layout).
  chalanNumber: string | null;
  chalanDate: string | null;

  // "CIP" renders the Cumulative Investment Plan layout (dividend reinvested,
  // no TDS/chalan). Anything else (null / "CASH") renders the standard
  // cash-dividend certificate, byte-for-byte unchanged.
  dividendMethod?: string | null;

  // Letterhead logo (top-right) and footer QR, as data URIs for Puppeteer;
  // the browser print page leaves them unset and resolves the public paths.
  logoDataUrl?: string; // falls back to /ekush-logo.png
  qrDataUrl?: string; // falls back to /cert-qr.png
  bannerDataUrl?: string; // deprecated (old top banner); no longer rendered
}

// Registration numbers — source of truth confirmed by the AMC (2026-07).
const FUND_REG: Record<string, { regNo: string }> = {
  EFUF: { regNo: "BSEC/Mutual Fund/2019/106" },
  EGF: { regNo: "BSEC/Mutual Fund/2021/125" },
  ESRF: { regNo: "BSEC/Mutual Fund/2022/137" },
};

const ORANGE = "#F27023";
const GREY_BG = "#f0f0f0";
const FONT = "Arial, Helvetica, sans-serif";

// A zero value renders as a dash. It's a block span so the dash centres in
// the column (mid-cell) rather than sitting at the right edge like a number.
const DASH = '<span style="display:block;text-align:center;">-</span>';

function fmt(n: number): string {
  if (!Number.isFinite(n)) return DASH;
  // Preserve the sign — Net Investment legitimately goes negative when
  // redemptions outweigh additions; toLocaleString prepends "-" automatically.
  // en-US grouping (2,000,000.00) to match the reference certificate — not the
  // Indian lakh grouping (20,00,000.00).
  const s = n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Any value that renders as zero — exact 0, tiny residuals that round to
  // "0.00", and the negative-zero "-0.00" — is shown as a centred dash.
  return s === "0.00" || s === "-0.00" ? DASH : s;
}

function fmtDateShort(d: Date | null): string {
  if (!d) return "N/A";
  // Month DD, YYYY (e.g. "July 01, 2025") to match the reference certificate.
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// NID applies to humans only. Non-individual entities (companies, funds) show
// their incorporation/registration number under a "Registration No." label.
// Some stored values already embed a label prefix, so strip it to avoid doubling.
function idLineHtml(data: TaxCertificateData, individualLabel: string): string {
  const isIndividual =
    (data.investorType || "INDIVIDUAL").toUpperCase() === "INDIVIDUAL";
  if (isIndividual) {
    return `<p style="font-size:10pt;margin:0;">${individualLabel}: ${escapeHtml(
      data.nidNumber || "N/A",
    )}</p>`;
  }
  const raw = (data.nidNumber || "")
    .replace(
      /^\s*(registration\s*no\.?|reg\.?\s*no\.?|national\s*id|nid)\s*[:.\-]*\s*/i,
      "",
    )
    .trim();
  return `<p style="font-size:10pt;margin:0;">Registration No.: ${escapeHtml(
    raw || "N/A",
  )}</p>`;
}

export function buildTaxCertificateBody(data: TaxCertificateData): string {
  // CIP investors reinvest their dividend (no TDS) and get a distinct layout.
  // Branch FIRST so the cash-dividend path below stays byte-for-byte unchanged.
  if ((data.dividendMethod || "").toUpperCase() === "CIP") {
    return buildCipCertificateBody(data);
  }

  const logoSrc = data.logoDataUrl ?? "/ekush-logo.png";
  const qrSrc = data.qrDataUrl ?? "/cert-qr.png";
  const regInfo = FUND_REG[data.fundCode] || FUND_REG.EFUF;

  const title = data.investorTitle || "Mr./Ms.";
  const issueYear = data.periodEnd
    ? new Date(data.periodEnd).getFullYear()
    : new Date().getFullYear();
  const issueDate = `1st July ${issueYear}`;

  const regRows = [
    ["Registration No", regInfo.regNo],
    ["Sponsor", "Ekush Wealth Management Limited"],
    ["Asset Manager", "Ekush Wealth Management Limited"],
    ["Trustee", "Sandhani Life Insurance Co. Ltd"],
    ["Custodian", "BRAC Bank Limited"],
  ]
    .map(
      ([label, val]) => `
        <tr>
          <td style="padding:1px 0;font-weight:600;white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:1px 8px;">:</td>
          <td style="padding:1px 0;">${escapeHtml(val)}</td>
        </tr>`,
    )
    .join("");

  // Dividend + chalan blocks are rendered ONLY when the cert carries that data,
  // so a no-dividend certificate stays identical to the reference letter while a
  // dividend-paying one shows the TDS + chalan needed for tax filing.
  const hasDividend =
    data.totalGrossDividend !== 0 || data.totalTax !== 0 || data.totalNetDividend !== 0;
  // The chalan is the TDS-deposit proof, so it only belongs on a certificate
  // that actually has a dividend. The chalan number/date are stored globally
  // per fund+period, so without this guard a zero-dividend investor (e.g.
  // A00053) would wrongly show the fund's chalan.
  const hasChalan = hasDividend && !!(data.chalanNumber || data.chalanDate);

  // A no-dividend cert must stay byte-for-byte identical to the reference letter
  // A00539 (verbatim — the AMC signed off on that exact layout). But adding the
  // Dividend Summary + Chalan blocks pushes the page to ~334mm, past A4's 297mm,
  // so it spills onto a 2nd page. When either block is present we switch to a
  // denser "compact" layout that reclaims ~45mm. When it's absent, every value
  // below resolves to the original literal, so the verbatim cert is unchanged.
  const compact = hasDividend || hasChalan;
  const cellPadY = compact ? "2px" : "4px";
  const padTop = "1.2in"; // fixed 1.2 inch top margin (AMC request)
  // Bottom padding only needs to clear the ~20mm footer band; keep it tight so
  // the 1.2in top margin doesn't push a dividend/long-name cert onto page 2.
  const padBottom = compact ? "24mm" : "28mm";
  const bodyLh = compact ? "1.32" : "1.45";
  const fundTopMargin = compact ? "4mm" : "8mm";
  const regBottomMargin = compact ? "3mm" : "6mm";
  const figuresBottomMargin = compact ? "3mm" : "8mm";
  const noteTopMargin = compact ? "3mm" : "6mm";

  // Bordered table cell styles (each ends with ";" so callers can append).
  const bd = "border:1px solid #000;padding:" + cellPadY + " 8px;font-family:" + FONT + ";font-size:10pt;";
  const bdR = bd + "text-align:right;";
  const hdr = bd + "font-weight:700;text-align:center;background:" + GREY_BG + ";";

  const dividendBlock = hasDividend
    ? `
      <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:10pt;margin-bottom:4mm;">
        <colgroup><col style="width:82%;"/><col style="width:18%;"/></colgroup>
        <tbody>
        <tr><td colspan="2" style="${hdr}text-align:left;">Dividend Summary</td></tr>
        <tr><td style="${bd}">Gross Dividend</td><td style="${bdR}">${fmt(data.totalGrossDividend)}</td></tr>
        <tr><td style="${bd}">Tax Deducted at Source</td><td style="${bdR}">${fmt(data.totalTax)}</td></tr>
        <tr><td style="${bd}">Net Dividend</td><td style="${bdR}font-weight:700;">${fmt(data.totalNetDividend)}</td></tr>
      </tbody></table>`
    : "";

  const chalanBlock = hasChalan
    ? `
      <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:10pt;margin-bottom:4mm;">
        <colgroup><col style="width:82%;"/><col style="width:18%;"/></colgroup>
        <tbody>
        <tr><td style="${bd}">Chalan Number</td><td style="${bdR}">${escapeHtml(data.chalanNumber || "-")}</td></tr>
        <tr><td style="${bd}">Chalan Date</td><td style="${bdR}">${escapeHtml(data.chalanDate || "-")}</td></tr>
      </tbody></table>`
    : "";

  return `
  <div
    id="tax-cert"
    class="print-page"
    style="width:210mm;min-height:295mm;background:#fff;font-family:${FONT};font-size:11pt;color:#000;line-height:${bodyLh};position:relative;"
  >
    <!-- Logo anchored to the page (not the padded body) so the 1.2in top
         margin doesn't push it down — keeps it in its previous position. -->
    <img src="${logoSrc}" alt="Ekush" crossorigin="anonymous" style="position:absolute;top:16mm;right:18mm;width:52mm;height:auto;" />
    <div style="padding:${padTop} 18mm ${padBottom} 18mm;">

      <!-- Header: date + investor left -->
      <div style="position:relative;min-height:22mm;">
        <p style="font-weight:700;margin:0 0 6mm 0;">${escapeHtml(issueDate)}</p>
        <p style="font-weight:700;margin:0;">${escapeHtml(title)} ${escapeHtml(data.investorName)}</p>
        ${idLineHtml(data, "NID")}
        <p style="font-size:10pt;margin:0;">TIN: ${escapeHtml(data.tinNumber || "N/A")}</p>
      </div>

      <!-- Fund block -->
      <h2 style="font-size:15pt;font-weight:700;text-align:center;margin:${fundTopMargin} 0 2mm 0;">${escapeHtml(data.fundName.toUpperCase())}</h2>
      <p style="font-size:9.5pt;text-align:center;color:#333;margin:0 0 4mm 0;">
        Registered under the Bangladesh Securities &amp; Exchange Commission<br/>(Mutual Fund) Rules, 2001.
      </p>
      <table style="margin:0 auto ${regBottomMargin} auto;font-size:10pt;border-collapse:collapse;"><tbody>${regRows}</tbody></table>

      <!-- To Whom It May Concern -->
      <h3 style="font-size:12.5pt;font-weight:700;text-align:center;text-decoration:underline;margin:0 0 4mm 0;">To Whom It May Concern</h3>
      <p style="font-size:10.5pt;text-align:justify;margin:0 0 5mm 0;">
        This is to certify <strong>${escapeHtml(title)} ${escapeHtml(data.investorName)}</strong> is a registered unit holder of
        <strong>${escapeHtml(data.fundName)}</strong>. Their detailed information regarding investment in the fund is given below:
      </p>

      <!-- Investment Period + Investor Code -->
      <table style="font-size:10.5pt;margin:0 0 4mm 0;"><tbody>
        <tr>
          <td style="font-weight:600;padding-right:10px;">Investment Period</td>
          <td style="padding-right:10px;">:</td>
          <td style="font-weight:700;">${escapeHtml(fmtDateShort(data.periodStart))}, to ${escapeHtml(fmtDateShort(data.periodEnd))}</td>
        </tr>
        <tr>
          <td style="font-weight:600;padding-right:10px;">Investor Code</td>
          <td style="padding-right:10px;">:</td>
          <td style="font-weight:700;">${escapeHtml(data.investorCode)}</td>
        </tr>
      </tbody></table>

      <!-- Opening | Closing Balances. Fixed layout + colgroup so the Opening
           half's cells are the exact same size as the Closing half's, even
           when the Opening values are all dashes. -->
      <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:10pt;margin-bottom:4mm;">
        <colgroup><col style="width:32%;"/><col style="width:18%;"/><col style="width:32%;"/><col style="width:18%;"/></colgroup>
        <tbody>
        <tr>
          <td colspan="2" style="${hdr}">Opening Balances</td>
          <td colspan="2" style="${hdr}">Closing Balances</td>
        </tr>
        <tr>
          <td style="${bd}">Cost Value of Investment</td><td style="${bdR}">${fmt(data.beginningCostValue)}</td>
          <td style="${bd}">Cost Value of Investment</td><td style="${bdR}">${fmt(data.endingCostValue)}</td>
        </tr>
        <tr>
          <td style="${bd}">Market Value of Investment</td><td style="${bdR}">${fmt(data.beginningMarketValue)}</td>
          <td style="${bd}">Market Value of Investment</td><td style="${bdR}">${fmt(data.endingMarketValue)}</td>
        </tr>
        <tr>
          <td style="${bd}">Total Unrealized Gain/(Loss)</td><td style="${bdR}">${fmt(data.beginningUnrealizedGain)}</td>
          <td style="${bd}">Total Unrealized Gain/(Loss)</td><td style="${bdR}">${fmt(data.endingUnrealizedGain)}</td>
        </tr>
      </tbody></table>

      <!-- During the Period. Fixed layout + 18% value column so this table's
           vertical divider lines up with the Opening|Closing table above. -->
      <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:10pt;margin-bottom:4mm;">
        <colgroup><col style="width:82%;"/><col style="width:18%;"/></colgroup>
        <tbody>
        <tr><td style="${bd}">Total Realized Gain during the Period</td><td style="${bdR}">${fmt(data.totalRealizedGain)}</td></tr>
        <tr><td style="${bd}">Total Addition during the Period</td><td style="${bdR}">${fmt(data.totalAdditionAtCost)}</td></tr>
        <tr><td style="${bd}">Total Redemption during the Period</td><td style="${bdR}">${fmt(data.totalRedemptionAtCost)}</td></tr>
        <tr><td style="${bd}">Net Investment (Net of Addition and Redemption) during the Period</td><td style="${bdR}">${fmt(data.netInvestment)}</td></tr>
      </tbody></table>
${dividendBlock}${chalanBlock}
      <p style="font-size:9pt;font-style:italic;color:#333;margin:0 0 ${figuresBottomMargin} 0;">(All figures in Bangladeshi Taka)</p>

      <p style="font-size:9pt;font-style:italic;color:#555;margin:${noteTopMargin} 0 0 0;">This is a computer-generated certificate and does not require a signature.</p>
    </div>

    <!-- Orange footer with verification QR -->
    <div style="position:absolute;bottom:0;left:0;right:0;background:${ORANGE};color:#fff;padding:5mm 14mm;display:flex;justify-content:space-between;align-items:center;font-size:8.5pt;">
      <div style="line-height:1.5;">
        <div style="font-weight:700;font-size:9.5pt;">Ekush Wealth Management Limited</div>
        <div>House 17, Road 1, Block A, Niketon, Dhaka-1212</div>
      </div>
      <div style="display:flex;gap:6mm;line-height:1.6;text-align:right;padding:0 8mm;">
        <div>
          <div>info@ekushwml.com</div>
          <div>www.ekushwml.com</div>
        </div>
        <div>
          <div>+8801713-086101</div>
          <div>+8801303-957569</div>
        </div>
      </div>
      <img src="${qrSrc}" alt="Verify" crossorigin="anonymous" style="width:16mm;height:16mm;background:#fff;padding:1mm;border-radius:2px;display:block;" />
    </div>
  </div>
  `.trim();
}

// Cumulative Investment Plan (CIP) certificate — for investors who reinvest
// their dividend instead of taking cash. No TDS, no chalan; the period's
// additions are broken into cash additions (A), the reinvested CIP amount (B),
// and redemptions (C), with Net = A + B − C. Verbatim to the AMC's EFUF_CIP
// reference. Reuses the same letterhead / reg block / footer as the cash cert.
function buildCipCertificateBody(data: TaxCertificateData): string {
  const logoSrc = data.logoDataUrl ?? "/ekush-logo.png";
  const qrSrc = data.qrDataUrl ?? "/cert-qr.png";
  const regInfo = FUND_REG[data.fundCode] || FUND_REG.EFUF;

  const title = data.investorTitle || "Mr./Ms.";
  const issueYear = data.periodEnd
    ? new Date(data.periodEnd).getFullYear()
    : new Date().getFullYear();
  const issueDate = `1st July ${issueYear}`;

  // Possessive pronoun from the title (falls back to the gender-neutral form).
  const t = (data.investorTitle || "").toLowerCase();
  const pronoun = /^(mrs|ms|miss)/.test(t) ? "Her" : /^mr/.test(t) ? "His" : "Their";

  // CIP breakdown — reproduces the AMC reference exactly:
  //   B (CIP)               = gross dividend (the reinvested amount)
  //   A (Additional Invest) = total additions at cost − the reinvested CIP
  //   C (Redemption)        = total redemption at cost
  //   Net (A+B−C)           = net investment
  const cip = data.totalGrossDividend;
  const additional = data.totalAdditionAtCost - data.totalGrossDividend;
  const redemption = data.totalRedemptionAtCost;
  const netInvestment = data.netInvestment;

  const regRows = [
    ["Registration No", regInfo.regNo],
    ["Sponsor", "Ekush Wealth Management Limited"],
    ["Asset Manager", "Ekush Wealth Management Limited"],
    ["Trustee", "Sandhani Life Insurance Co. Ltd"],
    ["Custodian", "BRAC Bank Limited"],
  ]
    .map(
      ([label, val]) => `
        <tr>
          <td style="padding:1px 0;font-weight:600;white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:1px 8px;">:</td>
          <td style="padding:1px 0;">${escapeHtml(val)}</td>
        </tr>`,
    )
    .join("");

  const bd = "border:1px solid #000;padding:4px 8px;font-family:" + FONT + ";font-size:10pt;";
  const bdR = bd + "text-align:right;";
  const hdr = bd + "font-weight:700;text-align:center;background:" + GREY_BG + ";";

  return `
  <div
    id="tax-cert"
    class="print-page"
    style="width:210mm;min-height:295mm;background:#fff;font-family:${FONT};font-size:11pt;color:#000;line-height:1.45;position:relative;"
  >
    <!-- Logo anchored to the page (not the padded body) so the 1.2in top
         margin doesn't push it down — keeps it in its previous position. -->
    <img src="${logoSrc}" alt="Ekush" crossorigin="anonymous" style="position:absolute;top:16mm;right:18mm;width:52mm;height:auto;" />
    <div style="padding:1.2in 18mm 28mm 18mm;">

      <!-- Header: date + investor left -->
      <div style="position:relative;min-height:22mm;">
        <p style="font-weight:700;margin:0 0 6mm 0;">${escapeHtml(issueDate)}</p>
        <p style="font-weight:700;margin:0;">${escapeHtml(title)} ${escapeHtml(data.investorName)}</p>
        ${idLineHtml(data, "National ID")}
        <p style="font-size:10pt;margin:0;">TIN: ${escapeHtml(data.tinNumber || "N/A")}</p>
      </div>

      <!-- Fund block -->
      <h2 style="font-size:15pt;font-weight:700;text-align:center;margin:8mm 0 2mm 0;">${escapeHtml(data.fundName.toUpperCase())}</h2>
      <p style="font-size:9.5pt;text-align:center;color:#333;margin:0 0 4mm 0;">
        Registered under the Bangladesh Securities &amp; Exchange Commission<br/>(Mutual Fund) Rules, 2001.
      </p>
      <table style="margin:0 auto 6mm auto;font-size:10pt;border-collapse:collapse;"><tbody>${regRows}</tbody></table>

      <!-- To Whom It May Concern -->
      <h3 style="font-size:12.5pt;font-weight:700;text-align:center;text-decoration:underline;margin:0 0 4mm 0;">To Whom It May Concern</h3>
      <p style="font-size:10.5pt;text-align:justify;margin:0 0 5mm 0;">
        This is to certify <strong>${escapeHtml(title)} ${escapeHtml(data.investorName)}</strong> is a registered unit holder of
        <strong>${escapeHtml(data.fundName)}</strong>. ${pronoun} detailed information regarding investment in the fund is given below:
      </p>

      <!-- Investment Period + Investor Code -->
      <table style="font-size:10.5pt;margin:0 0 4mm 0;"><tbody>
        <tr>
          <td style="font-weight:600;padding-right:10px;">Investment Period</td>
          <td style="padding-right:10px;">:</td>
          <td style="font-weight:700;">${escapeHtml(fmtDateShort(data.periodStart))}, to ${escapeHtml(fmtDateShort(data.periodEnd))}</td>
        </tr>
        <tr>
          <td style="font-weight:600;padding-right:10px;">Investor Code</td>
          <td style="padding-right:10px;">:</td>
          <td style="font-weight:700;">${escapeHtml(data.investorCode)}</td>
        </tr>
      </tbody></table>

      <!-- Particulars | Opening | Closing (CIP breakdown) -->
      <table style="width:100%;border-collapse:collapse;font-size:10pt;margin-bottom:4mm;"><tbody>
        <tr>
          <td style="${hdr}text-align:left;width:56%;">Particulars</td>
          <td style="${hdr}">Opening Balances</td>
          <td style="${hdr}">Closing Balances</td>
        </tr>
        <tr>
          <td style="${bd}">Cost Value of Investment</td>
          <td style="${bdR}">${fmt(data.beginningCostValue)}</td>
          <td style="${bdR}">${fmt(data.endingCostValue)}</td>
        </tr>
        <tr>
          <td style="${bd}">Market Value of Investment</td>
          <td style="${bdR}">${fmt(data.beginningMarketValue)}</td>
          <td style="${bdR}">${fmt(data.endingMarketValue)}</td>
        </tr>
        <tr>
          <td style="${bd}">Total Unrealized Gain</td>
          <td style="${bdR}">${fmt(data.beginningUnrealizedGain)}</td>
          <td style="${bdR}">${fmt(data.endingUnrealizedGain)}</td>
        </tr>
        <tr><td colspan="3" style="border:none;height:2mm;padding:0;"></td></tr>
        <tr>
          <td colspan="2" style="${bd}">Total Realized Gain during the Period</td>
          <td style="${bdR}">${fmt(data.totalRealizedGain)}</td>
        </tr>
        <tr>
          <td colspan="2" style="${bd}">Additional Investment during the Period (A)</td>
          <td style="${bdR}">${fmt(additional)}</td>
        </tr>
        <tr>
          <td colspan="2" style="${bd}">Cumulative Investment Plan (CIP) (B)</td>
          <td style="${bdR}">${fmt(cip)}</td>
        </tr>
        <tr>
          <td colspan="2" style="${bd}">Total Redemption during the Period (C)</td>
          <td style="${bdR}">${fmt(redemption)}</td>
        </tr>
        <tr>
          <td colspan="2" style="${bd}">Net Investment during the Period (A+B-C)</td>
          <td style="${bdR}">${fmt(netInvestment)}</td>
        </tr>
      </tbody></table>

      <p style="font-size:9pt;font-style:italic;color:#333;margin:0 0 8mm 0;">(All figures in Bangladeshi Taka)</p>

      <p style="font-size:9pt;font-style:italic;color:#555;margin:6mm 0 0 0;">This computer-generated statement does not require any signature.</p>
    </div>

    <!-- Orange footer with verification QR -->
    <div style="position:absolute;bottom:0;left:0;right:0;background:${ORANGE};color:#fff;padding:5mm 14mm;display:flex;justify-content:space-between;align-items:center;font-size:8.5pt;">
      <div style="line-height:1.5;">
        <div style="font-weight:700;font-size:9.5pt;">Ekush Wealth Management Limited</div>
        <div>House 17, Road 1, Block A, Niketon, Dhaka-1212</div>
      </div>
      <div style="display:flex;gap:6mm;line-height:1.6;text-align:right;padding:0 8mm;">
        <div>
          <div>info@ekushwml.com</div>
          <div>www.ekushwml.com</div>
        </div>
        <div>
          <div>+8801713-086101</div>
          <div>+8801303-957569</div>
        </div>
      </div>
      <img src="${qrSrc}" alt="Verify" crossorigin="anonymous" style="width:16mm;height:16mm;background:#fff;padding:1mm;border-radius:2px;display:block;" />
    </div>
  </div>
  `.trim();
}

export function buildTaxCertificateFullHtml(data: TaxCertificateData): string {
  return wrapCertPages(buildTaxCertificateBody(data));
}

// Multiple certificates in ONE PDF — each rendered with the identical verbatim
// layout, one per A4 page. Used by the admin bulk "PDF" export so it matches the
// single certificate the investor receives / downloads, page for page.
export function buildTaxCertificatesCombinedHtml(items: TaxCertificateData[]): string {
  return wrapCertPages(items.map(buildTaxCertificateBody).join("\n"));
}

function wrapCertPages(bodies: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Tax Certificate</title>
<style>
  @page { size: A4 portrait; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  * { box-sizing: border-box; }
  .print-page { page-break-after: always; }
  .print-page:last-of-type { page-break-after: auto; }
</style>
</head>
<body>
${bodies}
</body>
</html>`;
}
