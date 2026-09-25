'use client';

/** Opens the browser's print dialog, where "Save as PDF" is one of the printers. */
export function PrintButton() {
  return (
    <button className="primary" type="button" onClick={() => window.print()}>
      Print or save as PDF
    </button>
  );
}
