import subprocess,sys
runner=['python3','.measure-556/run.py']
try:
 subprocess.run([*runner,'before'],check=True)
 subprocess.run([*runner,'loaded','before','2','2'],check=True)
finally:
 subprocess.run([*runner,'restore'],check=True)
for pair in range(4):
 for iteration in range(1,11):
  subprocess.run([*runner,'loaded','after',str(iteration),str(pair)],check=True)
