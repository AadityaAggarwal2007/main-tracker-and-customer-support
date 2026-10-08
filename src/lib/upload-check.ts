// ── CSV upload: "is this the right panel?" (owner 2026-10-08) ───────────────────────────────
// Kurtiya got a wrong order (#1303) from a CSV upload: nothing checks that the file belongs to the
// panel the uploader chose. This turns what the server knows (brand names in the file, which
// panels already hold the file's order numbers) into plain warnings. The upload screen shows them
// and asks "Upload anyway?"; nothing is stopped by force (a store can have a brand that is not its
// panel name), but a mistake is never silent. Pure, no imports: unit-tested.

export interface UploadCheckInput {
  panelName: string;
  // Distinct order numbers in the file.
  total: number;
  // How many of them the chosen panel already has.
  inSelected: number;
  // Other panels that already hold some of them, with how many (largest first is not required).
  inOthers: { panel: string; count: number; sample: string[] }[];
  // Panels (other than the chosen one) whose name matches a brand written in the file, and whether
  // the chosen panel's name matches one too.
  brandPanelsOther: string[];
  brandMatchesSelected: boolean;
}

export interface UploadWarning {
  code: 'brand' | 'other_panel';
  message: string;
}

// A panel holds most of the file's order numbers (and the chosen one holds none): numbers repeat
// across stores, so a small overlap says nothing.
const OTHER_PANEL_SHARE = 0.8;
const OTHER_PANEL_MIN = 3;

export function uploadWarnings(i: UploadCheckInput): UploadWarning[] {
  const out: UploadWarning[] = [];
  if (i.brandPanelsOther.length > 0 && !i.brandMatchesSelected) {
    out.push({
      code: 'brand',
      message: `The brand in this file looks like ${i.brandPanelsOther.map((p) => `"${p}"`).join(' / ')}, but you chose "${i.panelName}".`,
    });
  }
  if (i.total > 0 && i.inSelected === 0) {
    const top = [...i.inOthers].sort((a, b) => b.count - a.count)[0];
    if (top && top.count >= OTHER_PANEL_MIN && top.count / i.total >= OTHER_PANEL_SHARE) {
      out.push({
        code: 'other_panel',
        message: `${top.count} of the ${i.total} order numbers in this file (${top.sample.slice(0, 3).map((s) => `#${s.replace(/^#/, '')}`).join(', ')}) are already in "${top.panel}", and none are in "${i.panelName}".`,
      });
    }
  }
  return out;
}
