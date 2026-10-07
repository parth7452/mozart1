# SAP Business One: the daily receivables export

For Frazil's SAP Business One partner. Send it with `format-v1.md`, which is
the file contract this query produces.

## 1. What we are asking for

Once a day, Business One runs one saved, read-only query and emails the result
as a CSV to an address we issue to Frazil. That is the whole integration.

- No port is opened into Frazil's network and no VPN is needed.
- We hold no Business One user or password.
- The query only reads. It never writes to the company database.

From the file we find invoices that customers paid short, which is what we
work on for Frazil (ADR 0075).

## 2. Status of the query below

**It is a draft and has not been run against a live company database.** It is
written from SAP's SDK table reference and from answers on SAP Community, and
those sources disagree on a few joins. Section 5 lists the checks to run on a
test company before scheduling it. Each check says what to change if it fails.
Our reader also checks every file it receives and refuses one that does not
add up, so a wrong query fails loudly, not quietly.

## 3. The query

Both versions produce the same columns in the same order. The window is the
45 days ending today. For each invoice touched in the window, it also exports
every payment, credit memo, reconciliation and journal entry ever applied to
it, whatever its date.

Tables used: `OINV` (A/R invoices), `ORCT` and `RCT2` (incoming payments and
the documents they paid), `ORIN` (A/R credit memos), `OITR` and `ITR1`
(internal reconciliations), `OJDT` (journal entries).

### 3a. Microsoft SQL Server

```sql
/* Recouple ledger export, format 1. SAP Business One on Microsoft SQL Server.
   DRAFT: run the checks in section 5 on a test company first. */
WITH
win AS (
  SELECT CAST(DATEADD(day, -44, CAST(GETDATE() AS date)) AS date) AS d_from,
         CAST(GETDATE() AS date)                                   AS d_to
),
pay_in AS (   -- incoming payments dated in the window
  SELECT p.DocEntry
  FROM ORCT p CROSS JOIN win
  WHERE p.Canceled = 'N' AND p.DocDate BETWEEN win.d_from AND win.d_to
),
rec_in AS (   -- reconciliations dated in the window
  SELECT o.ReconNum
  FROM OITR o CROSS JOIN win
  WHERE o.Canceled = 'N' AND o.ReconDate BETWEEN win.d_from AND win.d_to
),
inv AS (      -- every A/R invoice the window touched, or issued in it
  SELECT i.DocEntry
  FROM OINV i
  WHERE i.CANCELED = 'N'
    AND i.DocEntry IN (
      SELECT a.DocEntry FROM RCT2 a JOIN pay_in ON a.DocNum = pay_in.DocEntry
      WHERE CAST(a.InvType AS nvarchar(10)) = '13'
      UNION
      SELECT t.SrcObjAbs FROM ITR1 t JOIN rec_in ON t.ReconNum = rec_in.ReconNum
      WHERE t.SrcObjTyp = '13'
      UNION
      SELECT i2.DocEntry FROM OINV i2 CROSS JOIN win
      WHERE i2.DocDate BETWEEN win.d_from AND win.d_to
    )
),
pay AS (      -- every payment ever applied to those invoices
  SELECT DISTINCT p.DocEntry
  FROM ORCT p
  JOIN RCT2 a ON a.DocNum = p.DocEntry AND CAST(a.InvType AS nvarchar(10)) = '13'
  JOIN inv    ON inv.DocEntry = a.DocEntry
  WHERE p.Canceled = 'N'
),
rec AS (      -- every reconciliation of those invoices that is not a payment's own
  SELECT DISTINCT o.ReconNum
  FROM OITR o
  JOIN ITR1 t ON t.ReconNum = o.ReconNum AND t.SrcObjTyp = '13'
  JOIN inv    ON inv.DocEntry = t.SrcObjAbs
  WHERE o.Canceled = 'N'
    AND NOT EXISTS (SELECT 1 FROM ITR1 x
                    WHERE x.ReconNum = o.ReconNum AND x.SrcObjTyp = '24')
),
crd AS (      -- credit memos netted in those payments, or reconciled to those invoices
  SELECT a.DocEntry FROM RCT2 a JOIN pay ON a.DocNum = pay.DocEntry
  WHERE CAST(a.InvType AS nvarchar(10)) = '14'
  UNION
  SELECT t.SrcObjAbs FROM ITR1 t JOIN rec ON t.ReconNum = rec.ReconNum
  WHERE t.SrcObjTyp = '14'
),
jrn AS (      -- journal entries reconciled to those invoices
  SELECT t.SrcObjAbs AS TransId FROM ITR1 t JOIN rec ON t.ReconNum = rec.ReconNum
  WHERE t.SrcObjTyp = '30'
),
r AS (
  SELECT 'INVOICE'                              AS record_type,
         CAST(i.DocEntry AS nvarchar(20))       AS id,
         CAST(i.DocNum AS nvarchar(20))         AS number,
         CONVERT(char(10), i.DocDate, 23)       AS doc_date,
         CONVERT(char(10), i.DocDueDate, 23)    AS due_date,
         CAST(i.CardCode AS nvarchar(50))       AS customer_id,
         CAST(i.CardName AS nvarchar(100))      AS customer_name,
         CAST(i.DocCur AS nvarchar(3))          AS currency,
         CAST(i.DocTotal AS nvarchar(40))       AS amount,
         CAST(i.PaidToDate AS nvarchar(40))     AS paid_to_date,
         CAST(NULL AS nvarchar(40))             AS on_account,
         CAST(NULL AS nvarchar(40))             AS discount,
         CAST(NULL AS nvarchar(20))             AS parent_id,
         CAST(NULL AS nvarchar(20))             AS target_kind,
         CAST(NULL AS nvarchar(20))             AS target_id,
         CAST(NULL AS nvarchar(10))             AS kind,
         CAST(i.NumAtCard AS nvarchar(100))     AS reference,
         CAST(NULL AS nvarchar(254))            AS memo
  FROM OINV i JOIN inv ON inv.DocEntry = i.DocEntry

  UNION ALL
  SELECT 'PAYMENT', CAST(p.DocEntry AS nvarchar(20)), CAST(p.DocNum AS nvarchar(20)),
         CONVERT(char(10), p.DocDate, 23), NULL, p.CardCode, p.CardName, p.DocCurr,
         CAST(p.DocTotal AS nvarchar(40)), NULL, CAST(p.NoDocSum AS nvarchar(40)), NULL,
         NULL, NULL, NULL, NULL,
         p.CounterRef,                                   -- see check C9
         CAST(p.Comments AS nvarchar(254))
  FROM ORCT p JOIN pay ON pay.DocEntry = p.DocEntry

  UNION ALL
  SELECT 'PAYMENT_LINE',
         CAST(a.DocNum AS nvarchar(20)) + '-' + CAST(a.InvoiceId AS nvarchar(10)),
         NULL, NULL, NULL, NULL, NULL, NULL,
         CAST(CASE WHEN CAST(a.InvType AS nvarchar(10)) = '14' THEN ABS(a.SumApplied)  -- see check C3
                   ELSE a.SumApplied END AS nvarchar(40)),     -- see check C4
         NULL, NULL, CAST(a.DcntSum AS nvarchar(40)),
         CAST(a.DocNum AS nvarchar(20)),
         CASE CAST(a.InvType AS nvarchar(10)) WHEN '13' THEN 'INVOICE' WHEN '14' THEN 'CREDIT_MEMO'
              ELSE 'SAP_' + CAST(a.InvType AS nvarchar(10)) END,
         CAST(a.DocEntry AS nvarchar(20)), NULL, NULL, NULL
  FROM RCT2 a JOIN pay ON pay.DocEntry = a.DocNum

  UNION ALL
  SELECT 'CREDIT_MEMO', CAST(c.DocEntry AS nvarchar(20)), CAST(c.DocNum AS nvarchar(20)),
         CONVERT(char(10), c.DocDate, 23), NULL, c.CardCode, c.CardName, c.DocCur,
         CAST(c.DocTotal AS nvarchar(40)), NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         c.NumAtCard, CAST(c.Comments AS nvarchar(254))
  FROM ORIN c
  WHERE c.CANCELED = 'N' AND c.DocEntry IN (SELECT DocEntry FROM crd)

  UNION ALL
  SELECT 'JOURNAL_ENTRY', CAST(j.TransId AS nvarchar(20)), CAST(j.Number AS nvarchar(20)),
         CONVERT(char(10), j.RefDate, 23), NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         j.Ref1, CAST(j.Memo AS nvarchar(254))
  FROM OJDT j
  WHERE j.TransId IN (SELECT TransId FROM jrn)

  UNION ALL
  SELECT 'RECON_LINE',
         CAST(t.ReconNum AS nvarchar(20)) + '-' + CAST(t.LineSeq AS nvarchar(10)),
         NULL, CONVERT(char(10), o.ReconDate, 23), NULL, t.ShortName, NULL, NULL,
         CAST(t.ReconSum AS nvarchar(40)), NULL, NULL, NULL,
         CAST(t.ReconNum AS nvarchar(20)),
         CASE CAST(t.SrcObjTyp AS nvarchar(10))
              WHEN '13' THEN 'INVOICE' WHEN '14' THEN 'CREDIT_MEMO'
              WHEN '30' THEN 'JOURNAL_ENTRY'
              ELSE 'SAP_' + CAST(t.SrcObjTyp AS nvarchar(10)) END,
         CAST(t.SrcObjAbs AS nvarchar(20)),
         CAST(t.IsCredit AS nvarchar(10)),                -- see check C6
         CAST(o.ReconType AS nvarchar(10)), NULL
  FROM ITR1 t
  JOIN OITR o ON o.ReconNum = t.ReconNum
  JOIN rec    ON rec.ReconNum = t.ReconNum
)
SELECT '1' AS format, 'SAP_B1' AS source_system, DB_NAME() AS company,
       CONVERT(char(10), win.d_from, 23) AS window_from,
       CONVERT(char(10), win.d_to, 23)   AS window_to,
       r.record_type, r.id, r.number, r.doc_date AS [date], r.due_date,
       r.customer_id, r.customer_name, r.currency, r.amount, r.paid_to_date,
       r.on_account, r.discount, r.parent_id, r.target_kind, r.target_id,
       r.kind, r.reference, r.memo
FROM r CROSS JOIN win

UNION ALL
SELECT '1', 'SAP_B1', DB_NAME(),
       CONVERT(char(10), win.d_from, 23), CONVERT(char(10), win.d_to, 23),
       'CONTROL', 'CONTROL', CAST(COUNT(r.record_type) AS nvarchar(20)),
       NULL, NULL, NULL, NULL, NULL,
       CAST(COALESCE(SUM(CAST(r.amount AS decimal(19, 6))), 0) AS nvarchar(40)),
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM win LEFT JOIN r ON 1 = 1
GROUP BY win.d_from, win.d_to;
```

### 3b. SAP HANA

```sql
/* Recouple ledger export, format 1. SAP Business One on SAP HANA.
   DRAFT: run the checks in section 5 on a test company first.
   Run it with the company schema as the current schema. */
WITH
win AS (
  SELECT ADD_DAYS(CURRENT_DATE, -44) AS "d_from", CURRENT_DATE AS "d_to" FROM DUMMY
),
pay_in AS (
  SELECT p."DocEntry"
  FROM "ORCT" p CROSS JOIN win
  WHERE p."Canceled" = 'N' AND p."DocDate" BETWEEN win."d_from" AND win."d_to"
),
rec_in AS (
  SELECT o."ReconNum"
  FROM "OITR" o CROSS JOIN win
  WHERE o."Canceled" = 'N' AND o."ReconDate" BETWEEN win."d_from" AND win."d_to"
),
inv AS (
  SELECT i."DocEntry"
  FROM "OINV" i
  WHERE i."CANCELED" = 'N'
    AND i."DocEntry" IN (
      SELECT a."DocEntry" FROM "RCT2" a JOIN pay_in ON a."DocNum" = pay_in."DocEntry"
      WHERE TO_NVARCHAR(a."InvType") = '13'
      UNION
      SELECT t."SrcObjAbs" FROM "ITR1" t JOIN rec_in ON t."ReconNum" = rec_in."ReconNum"
      WHERE TO_NVARCHAR(t."SrcObjTyp") = '13'
      UNION
      SELECT i2."DocEntry" FROM "OINV" i2 CROSS JOIN win
      WHERE i2."DocDate" BETWEEN win."d_from" AND win."d_to"
    )
),
pay AS (
  SELECT DISTINCT p."DocEntry"
  FROM "ORCT" p
  JOIN "RCT2" a ON a."DocNum" = p."DocEntry" AND TO_NVARCHAR(a."InvType") = '13'
  JOIN inv      ON inv."DocEntry" = a."DocEntry"
  WHERE p."Canceled" = 'N'
),
rec AS (
  SELECT DISTINCT o."ReconNum"
  FROM "OITR" o
  JOIN "ITR1" t ON t."ReconNum" = o."ReconNum" AND TO_NVARCHAR(t."SrcObjTyp") = '13'
  JOIN inv      ON inv."DocEntry" = t."SrcObjAbs"
  WHERE o."Canceled" = 'N'
    AND NOT EXISTS (SELECT 1 FROM "ITR1" x
                    WHERE x."ReconNum" = o."ReconNum" AND TO_NVARCHAR(x."SrcObjTyp") = '24')
),
crd AS (
  SELECT a."DocEntry" FROM "RCT2" a JOIN pay ON a."DocNum" = pay."DocEntry"
  WHERE TO_NVARCHAR(a."InvType") = '14'
  UNION
  SELECT t."SrcObjAbs" FROM "ITR1" t JOIN rec ON t."ReconNum" = rec."ReconNum"
  WHERE TO_NVARCHAR(t."SrcObjTyp") = '14'
),
jrn AS (
  SELECT t."SrcObjAbs" AS "TransId" FROM "ITR1" t JOIN rec ON t."ReconNum" = rec."ReconNum"
  WHERE TO_NVARCHAR(t."SrcObjTyp") = '30'
),
r AS (
  SELECT 'INVOICE'                                   AS "record_type",
         TO_NVARCHAR(i."DocEntry")                   AS "id",
         TO_NVARCHAR(i."DocNum")                     AS "number",
         TO_NVARCHAR(i."DocDate", 'YYYY-MM-DD')      AS "doc_date",
         TO_NVARCHAR(i."DocDueDate", 'YYYY-MM-DD')   AS "due_date",
         TO_NVARCHAR(i."CardCode")                   AS "customer_id",
         TO_NVARCHAR(i."CardName")                   AS "customer_name",
         TO_NVARCHAR(i."DocCur")                     AS "currency",
         TO_NVARCHAR(i."DocTotal")                   AS "amount",
         TO_NVARCHAR(i."PaidToDate")                 AS "paid_to_date",
         CAST(NULL AS NVARCHAR(40))                  AS "on_account",
         CAST(NULL AS NVARCHAR(40))                  AS "discount",
         CAST(NULL AS NVARCHAR(20))                  AS "parent_id",
         CAST(NULL AS NVARCHAR(20))                  AS "target_kind",
         CAST(NULL AS NVARCHAR(20))                  AS "target_id",
         CAST(NULL AS NVARCHAR(10))                  AS "kind",
         TO_NVARCHAR(i."NumAtCard")                  AS "reference",
         CAST(NULL AS NVARCHAR(254))                 AS "memo"
  FROM "OINV" i JOIN inv ON inv."DocEntry" = i."DocEntry"

  UNION ALL
  SELECT 'PAYMENT', TO_NVARCHAR(p."DocEntry"), TO_NVARCHAR(p."DocNum"),
         TO_NVARCHAR(p."DocDate", 'YYYY-MM-DD'), NULL, p."CardCode", p."CardName", p."DocCurr",
         TO_NVARCHAR(p."DocTotal"), NULL, TO_NVARCHAR(p."NoDocSum"), NULL,
         NULL, NULL, NULL, NULL,
         p."CounterRef",                                         -- see check C9
         TO_NVARCHAR(p."Comments")
  FROM "ORCT" p JOIN pay ON pay."DocEntry" = p."DocEntry"

  UNION ALL
  SELECT 'PAYMENT_LINE',
         TO_NVARCHAR(a."DocNum") || '-' || TO_NVARCHAR(a."InvoiceId"),
         NULL, NULL, NULL, NULL, NULL, NULL,
         TO_NVARCHAR(CASE WHEN TO_NVARCHAR(a."InvType") = '14' THEN ABS(a."SumApplied")  -- see check C3
                          ELSE a."SumApplied" END),                       -- see check C4
         NULL, NULL, TO_NVARCHAR(a."DcntSum"),
         TO_NVARCHAR(a."DocNum"),
         CASE TO_NVARCHAR(a."InvType") WHEN '13' THEN 'INVOICE' WHEN '14' THEN 'CREDIT_MEMO'
              ELSE 'SAP_' || TO_NVARCHAR(a."InvType") END,
         TO_NVARCHAR(a."DocEntry"), NULL, NULL, NULL
  FROM "RCT2" a JOIN pay ON pay."DocEntry" = a."DocNum"

  UNION ALL
  SELECT 'CREDIT_MEMO', TO_NVARCHAR(c."DocEntry"), TO_NVARCHAR(c."DocNum"),
         TO_NVARCHAR(c."DocDate", 'YYYY-MM-DD'), NULL, c."CardCode", c."CardName", c."DocCur",
         TO_NVARCHAR(c."DocTotal"), NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         c."NumAtCard", TO_NVARCHAR(c."Comments")
  FROM "ORIN" c
  WHERE c."CANCELED" = 'N' AND c."DocEntry" IN (SELECT "DocEntry" FROM crd)

  UNION ALL
  SELECT 'JOURNAL_ENTRY', TO_NVARCHAR(j."TransId"), TO_NVARCHAR(j."Number"),
         TO_NVARCHAR(j."RefDate", 'YYYY-MM-DD'), NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         j."Ref1", TO_NVARCHAR(j."Memo")
  FROM "OJDT" j
  WHERE j."TransId" IN (SELECT "TransId" FROM jrn)

  UNION ALL
  SELECT 'RECON_LINE',
         TO_NVARCHAR(t."ReconNum") || '-' || TO_NVARCHAR(t."LineSeq"),
         NULL, TO_NVARCHAR(o."ReconDate", 'YYYY-MM-DD'), NULL, t."ShortName", NULL, NULL,
         TO_NVARCHAR(t."ReconSum"), NULL, NULL, NULL,
         TO_NVARCHAR(t."ReconNum"),
         CASE TO_NVARCHAR(t."SrcObjTyp")
              WHEN '13' THEN 'INVOICE' WHEN '14' THEN 'CREDIT_MEMO'
              WHEN '30' THEN 'JOURNAL_ENTRY'
              ELSE 'SAP_' || TO_NVARCHAR(t."SrcObjTyp") END,
         TO_NVARCHAR(t."SrcObjAbs"),
         TO_NVARCHAR(t."IsCredit"),                               -- see check C6
         TO_NVARCHAR(o."ReconType"), NULL
  FROM "ITR1" t
  JOIN "OITR" o ON o."ReconNum" = t."ReconNum"
  JOIN rec      ON rec."ReconNum" = t."ReconNum"
)
SELECT '1' AS "format", 'SAP_B1' AS "source_system", CURRENT_SCHEMA AS "company",
       TO_NVARCHAR(win."d_from", 'YYYY-MM-DD') AS "window_from",
       TO_NVARCHAR(win."d_to", 'YYYY-MM-DD')   AS "window_to",
       r."record_type", r."id", r."number", r."doc_date" AS "date", r."due_date",
       r."customer_id", r."customer_name", r."currency", r."amount", r."paid_to_date",
       r."on_account", r."discount", r."parent_id", r."target_kind", r."target_id",
       r."kind", r."reference", r."memo"
FROM r CROSS JOIN win

UNION ALL
SELECT '1', 'SAP_B1', CURRENT_SCHEMA,
       TO_NVARCHAR(win."d_from", 'YYYY-MM-DD'), TO_NVARCHAR(win."d_to", 'YYYY-MM-DD'),
       'CONTROL', 'CONTROL', TO_NVARCHAR(COUNT(r."record_type")),
       NULL, NULL, NULL, NULL, NULL,
       TO_NVARCHAR(COALESCE(SUM(CAST(r."amount" AS DECIMAL(19, 6))), 0)),
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM win LEFT JOIN r ON 1 = 1
GROUP BY win."d_from", win."d_to";
```

## 4. Where to put it

- **Don't add objects to the company database or schema.** SAP's support
  terms discourage changes there. A view in a separate database (SQL Server) or
  a separate schema with SELECT on the company's tables (HANA) is the usual
  practice. The scheduled job then runs `SELECT * FROM` that view.
- **Query Manager may reject the statement.** It has historically not accepted
  every statement that starts with `WITH`. Putting the statement in a view, as
  above, avoids that.
- **Read-only login.** Run it as a database login that can only SELECT those
  eight tables.
- **One snapshot.** The `CONTROL` row is computed in the same statement as the
  rows. If a document is posted while the query runs, the counts can disagree
  and we refuse that day's file; the next day's covers it. Snapshot isolation,
  where it is on, avoids that.

## 5. Checks to run on a test company first

Run the query on a copy of Frazil's company and check these against
documents you can open in the Business One client. The sources we wrote from
disagree on some of these points, so treat each as unconfirmed until it
passes.

| # | Check | If it fails |
| --- | --- | --- |
| C1 | Pick a payment that paid two invoices. Its `PAYMENT_LINE` rows have `parent_id` equal to the payment's internal key (`ORCT.DocEntry`), not its document number. | The join `RCT2.DocNum = ORCT.DocEntry` is wrong. Change every such join to the column that matches. |
| C2 | Each `PAYMENT_LINE` with `target_kind` `INVOICE` has `target_id` equal to that invoice's `OINV.DocEntry`. | Same as C1 for `RCT2.DocEntry`. |
| C3 | Pick a payment with a credit memo netted in it. Its credit memo line is `target_kind` `CREDIT_MEMO`, `RCT2.InvType` is 14, and the payment's cash = invoice lines − credit memo lines + on account. | Tell us how Business One stores that line. The `ABS()` assumes the stored sign may be negative. |
| C4 | Pick a payment where a cash discount was taken. `SumApplied` + `DcntSum` = the amount the invoice was relieved by, and `SumApplied` alone is cash. | If `SumApplied` already includes the discount, change the line's amount to `SumApplied - DcntSum`. |
| C5 | Pick an invoice closed by a credit memo with no payment. It has `RECON_LINE`s whose invoice row has `target_id` = the invoice's `DocEntry`, and the credit memo row has `target_kind` `CREDIT_MEMO` with the credit memo's `DocEntry`. | `ITR1.SrcObjAbs` does not hold `DocEntry` for these types. Tell us what it holds. |
| C6 | On that reconciliation, the invoice row and the credit memo row have different `kind` values (`IsCredit`). | Tell us what `IsCredit` holds. |
| C7 | A payment's own reconciliation is not exported as `RECON_LINE`s. | Payments are not reconciled with a receipt row (`SrcObjTyp` 24) in this version. Tell us how a payment's reconciliation is marked. |
| C8 | Pick 20 invoices at random. For each: `paid_to_date` = the `amount` plus `discount` of its payment lines + the `amount` of its invoice-side `RECON_LINE`s. | Something that relieves invoices at Frazil is missing from the export (for example a down payment, or a write-off through a different document). Tell us which. |
| C9 | `PAYMENT.reference` holds the check or remittance number Frazil's AR team uses. | Change `CounterRef` to the field they actually use. |
| C10 | Amounts have no thousands separators and dates are `YYYY-MM-DD`. The file is UTF-8 with one header row. | Fix the export settings, not the query. |
| C11 | A cancelled invoice and its cancellation document both stay out of the file. | Business One marks cancellations differently in this version. Tell us how. |

Our reader runs C8 on every invoice and the payment balance in C3 on every
payment, and refuses the whole file if one fails. Running them first means
the first file goes through.

## 6. Sending it

- **To:** the address we issue when Frazil's owner creates the connection in
  the app. It looks like `<32 hex characters>@in.mozart.financial`. Keep it
  private; anyone who has it can send us a file.
- **When:** once a day at a fixed time, for example 05:00 Frazil local time.
  If no file arrives for two days, we are alerted.
- **What:** one email, one attachment, CSV preferred (XLSX accepted).
  Filename `recouple-ledger-YYYY-MM-DD.csv`.

Any of these routes works. The partner picks:

| Route | Notes |
| --- | --- |
| Business One's Report Execution Scheduler (Query Manager), mailed by SBO Mailer | Built in. Confirm which attachment formats Frazil's version sends. One SAP Community thread reports scheduled emails arriving with no attachment because the conversion step failed. |
| A scheduled script on the database server | For example `sqlcmd` or `bcp` (SQL Server) or `hdbsql` (HANA) writing the CSV, then a scheduled task that emails it. The most predictable. |
| The hosting partner's own scheduler | If Business One is hosted, the host may already run scheduled exports. |
| By hand | Someone exports the query and uploads the file in the app. Fine for the first weeks. |

## 7. The first file

Before anything is scheduled, Frazil's owner uploads one file from the
production company on the connection page in the app. Our reader runs every
check in `format-v1.md` and says what passed or which rows failed. The owner
then confirms it is Frazil's ledger. After that, the schedule is turned on and
daily files are read without anyone pressing anything, as long as the company,
format and window carry on from the confirmed one.

## 8. Questions for the partner

1. Is Frazil's Business One on SQL Server or HANA, and which version?
2. Is it on Frazil's own server or hosted by you?
3. Which delivery route in section 6 do you prefer?
4. Does anything else relieve an A/R invoice at Frazil besides payments,
   credit memos and reconciliations against journal entries? Down payments,
   bills of exchange and correction invoices are the ones we know we don't
   handle yet.
