import csv, concurrent.futures, datetime, json, urllib.request, urllib.error
from pathlib import Path
rows=list(csv.DictReader(Path('../Synq_Agent_Build_Pack_v1.2/sources/source_registry.csv').open()))
selected=[r for r in rows if any(p in r['recheck_phase'] for p in ('P00','P01','P02','P03','P04','P05'))]
def probe(row):
    result={k:row[k] for k in ('id','title','url','authority','recheck_phase')}
    result['checked_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        request=urllib.request.Request(row['url'],headers={'User-Agent':'Synq-source-validation/0.1'})
        with urllib.request.urlopen(request,timeout=20) as response:
            result.update(status=response.status,resolved_url=response.url,content_type=response.headers.get('content-type'),bytes_sampled=len(response.read(65536)))
    except Exception as error:
        result.update(status='UNAVAILABLE',error=str(error))
    return result
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    results=list(pool.map(probe,selected))
Path('reports/evidence/source-probes.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps({'checked':len(results),'resolved':sum(r['status']==200 for r in results),'unavailable':[{k:r[k] for k in ('id','url','status')} for r in results if r['status']!=200]},indent=2))
