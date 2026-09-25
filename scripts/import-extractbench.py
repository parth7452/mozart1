#!/usr/bin/env python3
"""
Imports the ExtractBench documents behind the `public` and `public_scanned`
suites (packages/fixtures/public/).

ExtractBench (https://github.com/run-llama/ExtractBench, dataset
llamaindex/ExtractBench on Hugging Face, Apache 2.0) is real documents from
public records, each with an answer its authors verified. This script copies the
chosen PDFs, writes each one's text layer, and turns ExtractBench's verified
answers into our ground truth for the fields that map onto ours — never a value
of our own. The rules are fixed here, before any recording, and the README
beside the output says them in prose.

    python3 scripts/import-extractbench.py            # downloads into a cache
    python3 scripts/import-extractbench.py --cache DIR

Needs `pypdf`. Offline tooling: nothing in CI runs it, and its output is
committed. Running it again on the same revision rewrites the same files.
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

# pypdf imports `cryptography` for encrypted files when it is installed, and a
# broken system install of it takes pypdf down with it. None of these files is
# encrypted, so pypdf's own fallback is enough.
sys.modules.setdefault("cryptography", None)  # type: ignore[arg-type]
import pypdf  # noqa: E402

DATASET = "llamaindex/ExtractBench"
REVISION = "f6180e917a050a84582e6366cff85b7dc1e84e58"  # 2026-08-19
BASE = f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}"

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "packages" / "fixtures" / "public"

# key, ExtractBench stem, our type, suite, pages kept (1-based; None = all).
#
# The two Mississippi documents are sections of the state's provider billing
# handbook: prose and a table of field descriptions, then the sample remittance
# advice itself. Only the advice pages are kept, so the document is what a
# payee would receive rather than a manual about it.
DOCUMENTS: list[tuple[str, str, str, str, list[int] | None]] = [
    ("eb-ms-medicaid-ra-adjustments", "ms_medicaid_ra_adjustments", "remittance_advice", "public", [4]),
    ("eb-ms-medicaid-ra-paid-denied", "ms_medicaid_ra_paid_denied_claims", "remittance_advice", "public", [5, 6]),
    ("eb-grafton-isotrope-invoice", "grafton_isotrope_invoice_19503", "invoice", "public", None),
    ("eb-mission-tyler-invoice", "mission-tx-tyler-invoice", "invoice", "public", None),
    ("eb-southampton-york-invoice", "southampton-ny-york-env-invoice", "invoice", "public", None),
    ("eb-stephenville-axon-invoice", "stephenville-axon-invoice", "invoice", "public", None),
    ("eb-oklahoma-county-po", "oklahoma_county_purchase_order_avl_systems", "po", "public", None),
    ("eb-texas-facilities-po", "texas_facilities_commission_purchase_order_shelton-keller", "po", "public", None),
    ("eb-uillinois-rate-card", "uillinois_rate_card_carpool_2024", "price_agreement", "public", None),
    ("eb-utah-fleet-rates", "utah_fleet_rate_schedule_fy2024", "price_agreement", "public", None),
    # Pages with no usable text layer of their own: read through OCR, as
    # production reads every upload. Two scans with none, two scans whose
    # embedded OCR layer is too noisy to stand in for ours, and ExtractBench's
    # degraded capture of six of the documents above.
    ("eb-aclu-cdw-invoice-scan", "aclu_cdwg_invoice", "invoice", "public_scanned", None),
    ("eb-fort-bend-invoice-scan", "fort_bend_operativeiq_invoice", "invoice", "public_scanned", None),
    ("eb-hingham-grainger-invoice-scan", "hingham-grainger-invoice", "invoice", "public_scanned", None),
    ("eb-hingham-wbmason-invoice-scan", "hingham-wbmason-invoice", "invoice", "public_scanned", None),
    ("eb-ms-medicaid-ra-adjustments-degraded", "ms_medicaid_ra_adjustments_corrupted", "remittance_advice", "public_scanned", [4]),
    ("eb-ms-medicaid-ra-paid-denied-degraded", "ms_medicaid_ra_paid_denied_claims_corrupted", "remittance_advice", "public_scanned", [5, 6]),
    ("eb-oklahoma-county-po-degraded", "oklahoma_county_purchase_order_avl_systems_corrupted", "po", "public_scanned", None),
    ("eb-texas-facilities-po-degraded", "texas_facilities_commission_purchase_order_shelton-keller_corrupted", "po", "public_scanned", None),
    ("eb-uillinois-rate-card-degraded", "uillinois_rate_card_carpool_2024_corrupted", "price_agreement", "public_scanned", None),
    ("eb-utah-fleet-rates-degraded", "utah_fleet_rate_schedule_fy2024_corrupted", "price_agreement", "public_scanned", None),
]

MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def fetch(cache: Path, name: str) -> bytes:
    path = cache / name
    if not path.exists() or path.stat().st_size == 0:
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(f"{BASE}/{name}", timeout=300) as response:
            data = response.read()
        path.write_bytes(data)
    data = path.read_bytes()
    if name.endswith(".pdf") and not data.startswith(b"%PDF-"):
        # Hugging Face answers a busy moment with a 503 page, not a PDF.
        path.unlink()
        raise SystemExit(f"{name}: the download is not a PDF; run again")
    return data


def keep_pages(data: bytes, pages: list[int] | None) -> bytes:
    if pages is None:
        return data
    reader = pypdf.PdfReader(io.BytesIO(data))
    writer = pypdf.PdfWriter()
    for number in pages:
        writer.add_page(reader.pages[number - 1])
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


# The keys `packages/ingest/src/sniff.ts` refuses a PDF for. The two Hingham
# scans carry `/OpenAction [1 0 R /Fit]`, which only tells a viewer to show the
# first page whole, and the door refuses the key whatever it points at, so a
# customer would be told to flatten the file first. Here the key is removed
# instead, so the suite measures reading rather than refusal. Three more files
# were refused for `/AA` until the door read names whole: it was inside their
# fonts' names (`/AAAAAB+Arial`), and there was no key to remove.
ACTIVE_KEYS = ("/AA", "/OpenAction", "/JavaScript", "/JS", "/Launch", "/RichMedia", "/XFA")


def flatten(data: bytes) -> tuple[bytes, list[str]]:
    """The same pages with every action a viewer would run removed, and which keys went."""
    reader = pypdf.PdfReader(io.BytesIO(data))
    writer = pypdf.PdfWriter(clone_from=reader)
    removed: set[str] = set()
    seen: set[int] = set()

    def scrub(node: object) -> None:
        node = node.get_object() if hasattr(node, "get_object") else node
        if id(node) in seen:
            return
        seen.add(id(node))
        if isinstance(node, pypdf.generic.DictionaryObject):
            for key in ACTIVE_KEYS:
                if key in node:
                    del node[key]
                    removed.add(key)
            for value in list(node.values()):
                scrub(value)
        elif isinstance(node, pypdf.generic.ArrayObject):
            for value in node:
                scrub(value)

    scrub(writer._root_object)
    if not removed:
        return data, []
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue(), sorted(removed)


def page_texts(data: bytes) -> list[str]:
    reader = pypdf.PdfReader(io.BytesIO(data))
    return [(page.extract_text() or "").strip() for page in reader.pages]


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def on_page(value: str, text: str) -> bool:
    return squash(value) in squash(text)


def money_on_page(amount: float, text: str) -> bool:
    forms = {f"{abs(amount):,.2f}", f"{abs(amount):.2f}"}
    if float(amount).is_integer():
        forms |= {f"{abs(int(amount)):,}"}
    compact = text.replace(" ", "")
    return any(form in compact for form in forms)


def cents(amount: float) -> int:
    return int(round(amount * 100))


def printed_date(iso: str, text: str) -> str | None:
    """The one spelling of this calendar date the page uses, or None."""
    try:
        day = dt.date.fromisoformat(iso)
    except ValueError:
        return None
    m, d, y = day.month, day.day, day.year
    month = MONTHS[m - 1]
    # Every month-first spelling, so a date the page prints two ways is seen
    # as printed two ways. Day-first numbers are left out: this is a US corpus
    # and `parsePrintedDate` is month-first too. The first list lacked the
    # two-digit-year month names, so Stephenville's `01-May-24` beside its
    # lines' `05/01/2024` went unseen and the wrong one was kept.
    days = {f"{d}", f"{d:02d}"}
    years = {f"{y}", f"{y % 100:02d}"}
    months = {f"{m}", f"{m:02d}"}
    names = {month, month[:3], f"{month[:3]}."}
    candidates = {f"{y}-{m:02d}-{d:02d}", f"{y}/{m:02d}/{d:02d}"}
    candidates |= {f"{mo}{sep}{da}{sep}{yr}" for mo in months for da in days for yr in years for sep in "/-."}
    candidates |= {f"{na} {da}, {yr}" for na in names for da in days for yr in years}
    candidates |= {f"{na} {da} {y}" for na in names for da in days}
    candidates |= {f"{da} {na} {yr}" for na in names for da in days for yr in years}
    candidates |= {f"{da}{sep}{month[:3]}{sep}{yr}" for da in days for yr in years for sep in "-/"}
    found = sorted(
        c for c in candidates
        if re.search(rf"(?<![0-9A-Za-z]){re.escape(c)}(?![0-9A-Za-z])", text, flags=re.IGNORECASE)
    )
    return found[0] if len(found) == 1 else None


def text_truth(value: str) -> dict:
    return {"kind": "text", "value": value}


def truth_for(doc_type: str, expected: dict, text: str | None) -> tuple[dict, list[str]]:
    """
    ExtractBench's verified answer, mapped onto our field paths.

    `text` is the page text to check each value against, or None for a page
    with no text of its own to check. A value that cannot be checked against
    text we have is still kept when it is an identifier, a name or an amount —
    ExtractBench verified it — but a date is kept only when the page shows how
    it is printed, because our scorer compares a date as printed text.
    """
    truth: dict[str, dict] = {}
    skipped: list[str] = []

    def put_text(path: str, value: object) -> None:
        if value is None or str(value).strip() == "":
            return
        if text is not None and not on_page(str(value), text):
            skipped.append(f"{path}: {value!r} is not in the page text")
            return
        truth[path] = text_truth(str(value))

    def put_money(path: str, value: object) -> None:
        if value is None:
            return
        amount = float(value)
        if text is not None and not money_on_page(amount, text):
            skipped.append(f"{path}: {amount} is not printed on the page")
            return
        truth[path] = {"kind": "money_cents", "value": cents(amount)}

    def put_int(path: str, value: object) -> None:
        if value is None or not float(value).is_integer():
            return
        truth[path] = {"kind": "int", "value": int(value)}

    def put_date(path: str, iso: object) -> None:
        if iso is None:
            return
        if text is None:
            skipped.append(f"{path}: {iso} has no page text to show how it is printed")
            return
        printed = printed_date(str(iso), text)
        if printed is None:
            skipped.append(f"{path}: {iso} is not printed in exactly one spelling on the page")
            return
        truth[path] = {"kind": "date", "value": printed}

    if doc_type == "invoice":
        put_text("invoice_number", expected.get("invoice_number"))
        put_date("invoice_date", expected.get("date"))
        put_text("po_number", expected.get("purchase_order_number"))
        put_text("customer_name", (expected.get("customer") or {}).get("name"))
        put_money("invoice_total", expected.get("total_amount"))
        for i, line in enumerate(expected.get("line_items") or []):
            put_int(f"lines[{i}].qty", line.get("quantity"))
            put_money(f"lines[{i}].unit_cost", line.get("unit_price"))
            put_money(f"lines[{i}].extended_amount", line.get("amount"))
    elif doc_type == "po":
        put_text("po_number", expected.get("po_number"))
        put_date("po_date", expected.get("po_date"))
        put_text("buyer_name", (expected.get("buyer") or {}).get("name"))
        for i, line in enumerate(expected.get("line_items") or []):
            put_int(f"lines[{i}].qty_ordered", line.get("quantity"))
            put_money(f"lines[{i}].unit_cost", line.get("unit_price"))
    elif doc_type == "remittance_advice":
        payments = expected.get("payments") or []
        payers = {p.get("payer_name") for p in payments}
        if len(payers) == 1:
            put_text("payer_name", payments[0].get("payer_name"))
        if len(payments) == 1:
            # Our schema holds one payment per advice; with several, which one
            # "the" reference is would be our choice, not theirs.
            put_text("payment_reference", payments[0].get("check_number"))
            put_text("payment_date", payments[0].get("ra_date"))
            if "payment_date" in truth:
                truth["payment_date"]["kind"] = "date"
            put_money("payment_total", payments[0].get("check_amount"))
        else:
            skipped.append(f"payment_reference, payment_date, payment_total: {len(payments)} payments on one advice")
        for i, claim in enumerate(expected.get("claims") or []):
            put_money(f"lines[{i}].gross_amount", claim.get("total_submitted"))
            put_money(f"lines[{i}].net_amount", claim.get("total_paid"))
            put_text(f"lines[{i}].reason_code", claim.get("reason_codes"))
    elif doc_type == "price_agreement":
        period = expected.get("effective_period")
        if period:
            match = re.search(
                rf"(?:{'|'.join(MONTHS)}) \d{{1,2}}, \d{{4}}|\d{{1,2}}/\d{{1,2}}/\d{{2,4}}", str(period)
            )
            if match:
                put_text("effective_from", match.group(0))
                if "effective_from" in truth:
                    truth["effective_from"]["kind"] = "date"
            else:
                skipped.append(f"effective_from: {period!r} names no date")
    else:
        raise SystemExit(f"no mapping for {doc_type}")
    return truth, skipped


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache", type=Path, default=Path(tempfile.gettempdir()) / "extractbench-cache")
    args = parser.parse_args()

    records = {}
    for line in fetch(args.cache, "short.jsonl").decode("utf-8").splitlines():
        record = json.loads(line)
        records[record["id"].split("/", 1)[1]] = record

    OUT.mkdir(parents=True, exist_ok=True)
    pages_out: dict[str, dict] = {}
    truth_out: dict[str, dict] = {}
    clean_text: dict[str, str] = {}

    for key, stem, doc_type, suite, pages in DOCUMENTS:
        record = records[stem]
        original = fetch(args.cache, f"docs/short/{stem}.pdf")
        data, flattened = flatten(keep_pages(original, pages))
        (OUT / f"{key}.pdf").write_bytes(data)
        texts = page_texts(data)

        if suite == "public":
            page_text = texts
            check_against = "\n".join(texts)
            clean_text[stem] = check_against
        else:
            # No text layer is handed to the recorder: it OCRs these, as
            # production does. Values are checked against the clean twin's
            # text where there is one, else against the page's own embedded
            # layer, however rough, else not at all.
            page_text = []
            twin = stem.removesuffix("_corrupted")
            embedded = "\n".join(texts)
            check_against = clean_text.get(twin) or (embedded if embedded.strip() else None)

        expected = json.loads(record["expected_output"])
        truth, skipped = truth_for(doc_type, expected, check_against)
        pages_out[key] = {
            "filename": f"{key}.pdf",
            "docType": doc_type,
            "suite": suite,
            "pageText": page_text,
            "source": {
                "dataset": DATASET,
                "revision": REVISION,
                "id": record["id"],
                "pdf": record["pdf"],
                **({"pagesKept": pages} if pages is not None else {}),
                # What the upload door would have refused the original for.
                **({"flattened": flattened} if flattened else {}),
                "tags": record["tags"],
            },
        }
        truth_out[key] = {"truth": truth, "skipped": skipped}
        print(f"{key:44s} {suite:15s} {doc_type:18s} {len(truth):3d} truth, {len(skipped)} skipped")

    (OUT / "pages.json").write_text(json.dumps(pages_out, indent=2, ensure_ascii=False) + "\n")
    (OUT / "truth.json").write_text(json.dumps(truth_out, indent=2, ensure_ascii=False) + "\n")
    print(f"\nwrote {len(DOCUMENTS)} documents to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
