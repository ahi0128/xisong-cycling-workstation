"""Export anonymous monthly totals from a verified 2026 workbook."""
import calendar
import json
import math
import sys
from decimal import Decimal
from openpyxl import load_workbook

MONTHS = "一 二 三 四 五 六 七 八 九 十 十一 十二".split()
YEAR = 2026

def number(value, location, allow_negative=False):
    if value is None:
        return Decimal(0)
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f"{location} requires a numeric value")
    amount = Decimal(str(value))
    if (amount < 0 and not allow_negative) or amount != amount.quantize(Decimal("0.01")):
        raise ValueError(f"{location} has an invalid amount")
    return amount

def export(path):
    book = load_workbook(path, read_only=False, data_only=False)
    summary = book["總表"]
    opening = number(summary["B2"].value, "總表 B2", allow_negative=True)
    reports = []
    for month, name in enumerate(MONTHS, 1):
        sheet = book[name + "月"]
        month_id = f"{YEAR}-{month:02}"
        if summary.cell(month + 4, 1).value != month_id:
            raise ValueError("Unexpected month row")
        income = expense = Decimal(0)
        for day in range(1, 32):
            amount_column = 11 + 2 * day
            for row in range(4, 23):
                cell = sheet.cell(row, amount_column)
                item = sheet.cell(row, amount_column - 1)
                if day > calendar.monthrange(YEAR, month)[1] and (cell.value is not None or item.value is not None):
                    raise ValueError(f"{month_id} has an invalid date")
                if cell.value is not None and not str(item.value or "").strip():
                    raise ValueError(f"{month_id} {cell.coordinate} needs an item name")
                amount = number(cell.value, f"{month_id} {cell.coordinate}")
                if row == 4:
                    income += amount
                else:
                    expense += amount
        closing = opening + income - expense
        if summary.cell(month + 4, 6).value == "發布":
            reports.append(dict(month=month_id, opening=float(opening), income=float(income),
                                expense=float(expense), closing=float(closing)))
        opening = closing
    return {"year": YEAR, "reports": reports}

if __name__ == "__main__":
    print(json.dumps(export(sys.argv[1]), ensure_ascii=False, indent=2))
