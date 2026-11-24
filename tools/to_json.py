import sys, json, openpyxl
def disp(v):
    if v is None: return ''
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    return str(v)
out = {}
for spec in sys.argv[2:]:
    path, *tabs = spec.split('::')
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    for ws in wb.worksheets:
        if tabs and ws.title not in tabs: continue
        out[ws.title] = [[disp(v) for v in r] for r in ws.iter_rows(values_only=True)]
json.dump(out, open(sys.argv[1], 'w'), ensure_ascii=False)
print(sys.argv[1], list(out))
