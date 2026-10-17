import pathlib,json,re
out=pathlib.Path(__file__).parent
for line in (out/'runs.jsonl').read_text().splitlines():
    row=json.loads(line); log=(out/(row['label']+'.log')).read_text(); cases=[]
    for status,name,ms in re.findall(r'\((pass|fail)\) (.*?) \[([\d.]+)ms\]',log):
        cases.append((status,name,float(ms)/1000))
    failed=[name for status,name,ms in cases if status=='fail']
    print(row['label'], 'exit='+str(row['exit']), 'wall='+str(row['seconds']), 'cases='+str(len(cases)), 'fail='+str(failed))
