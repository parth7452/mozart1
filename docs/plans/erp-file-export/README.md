# A ledger read from a file the ERP sends

ADR 0075 (proposed): instead of an API integration per ERP, the customer's
ERP sends us one file a day in a format we own, and code reads it.

| File | For | What it is |
| --- | --- | --- |
| `format-v1.md` | Any ERP partner | The file contract: columns, record types, values, and the checks we run on every file |
| `sap-business-one.md` | Frazil's SAP partner | The draft query for SQL Server and HANA, where to put it, the checks to run on a test company, and how to send it |

Status: nothing is built. The query is a draft that has not run against a live
Business One database; `sap-business-one.md` §5 is how it gets verified. The
reader, the connection door and the migration come after ADR 0075 is accepted.
