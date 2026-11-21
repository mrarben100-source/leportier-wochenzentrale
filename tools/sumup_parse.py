import zipfile,io,csv,glob,collections,datetime,json,sys
num=lambda s: float((s or '0').replace("'","").replace(',','.') or 0)
sales=[];items=[];daily=[];pays=[]
for z in sorted(glob.glob(sys.argv[1]+'/fiscal-daily-archive-*.zip')):
    with zipfile.ZipFile(z) as zz:
        for n in zz.namelist():
            rows=list(csv.DictReader(io.TextIOWrapper(zz.open(n),encoding='utf-8-sig'),delimiter=';'))
            if 'sales-totals' in n: sales+=rows
            elif 'sales-items' in n: items+=rows
            elif 'daily-totals-payments' in n: pays+=rows
            elif n.startswith('fiscal-report-daily-totals-2'): daily+=rows
ok=lambda r: True
night=lambda ts: (datetime.datetime.strptime(ts,'%Y-%m-%d %H:%M:%S')-datetime.timedelta(hours=6)).date().isoformat()
# Zahlarten pro Kalendertag (Anteile)
pm=collections.defaultdict(lambda: collections.Counter())
for p in pays: pm[p['Opening Date'][:10]][p['Payment Method']]+=num(p['Total Payments'])
N={}
for s in sales:
    if not ok(s): continue
    d=night(s['Fiscal Date']); n=N.setdefault(d,{'datum':d,'inkl':0,'exkl':0,'mwst':0,'tg':0,'belege':0,'methoden':collections.Counter(),'produkte':{},'von':s['Fiscal Date'],'bis':s['Fiscal Date']})
    v=num(s['Total Sales Incl Tax']); n['inkl']+=v; n['exkl']+=num(s['Total Sales Excl Tax']); n['mwst']+=num(s['Total Tax Amount']); n['tg']+=num(s['Total Tips']); n['belege']+=1 if s['Sale Type']=='Sale' else 0
    n['von']=min(n['von'],s['Fiscal Date']); n['bis']=max(n['bis'],s['Fiscal Date'])
    m=s.get('Payment Method')
    if m: n['methoden'][m]+=v
    else:
        c=pm[s['Fiscal Date'][:10]]; t=sum(c.values())
        for k,x in c.items(): n['methoden'][k]+= v*x/t if t else 0
for i in items:
    if not ok(i): continue
    d=night(i['Fiscal Date']); n=N.get(d)
    if not n: continue
    nm=i['Item Name'].strip() or 'Ohne Name'; p=n['produkte'].setdefault(nm,[0,0]); p[0]+=num(i['Quantity']); p[1]+=num(i['Total Sales Incl Tax'])
out=[]
for d,n in sorted(N.items()):
    out.append({'datum':d,'quelle':'sumup','umsatz_inkl':round(n['inkl'],2),'umsatz_exkl':round(n['exkl'],2),'mwst':round(n['mwst'],2),'trinkgeld':round(n['tg'],2),'belege':n['belege'],
      'von':n['von'],'bis':n['bis'],'methoden':{k:round(v,2) for k,v in n['methoden'].items() if round(v,2)},
      'produkte':[{'name':k,'menge':round(v[0],2),'umsatz':round(v[1],2)} for k,v in sorted(n['produkte'].items(),key=lambda x:-x[1][1])[:40]]})
json.dump(out,open('sumup_naechte.json','w'),ensure_ascii=False)
print('Naechte',len(out),'Summe',round(sum(o['umsatz_inkl'] for o in out),2),'Daily-Total',round(sum(num(r['Total Sales Incl Tax']) for r in daily),2))
print('Methoden',collections.Counter({k:round(v) for o in out for k,v in o['methoden'].items()}))
y=collections.Counter();[y.update({o['datum'][:4]:o['umsatz_inkl']}) for o in out];print({k:round(v) for k,v in y.items()})
for o in out[-6:]: print(o['datum'],o['umsatz_inkl'],o['belege'],o['methoden'],o['produkte'][:2])
