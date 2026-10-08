"""Exercise only the exported app: no shell-launched room or developer Node needed."""
import pathlib, subprocess, sys, socket, time, platform
APP=pathlib.Path(sys.argv[1]).resolve()
EVIDENCE=pathlib.Path(__file__).parent/'evidence'
EVIDENCE.mkdir(exist_ok=True)
def listening():
    try:
        with socket.create_connection(('127.0.0.1',28765),.2):return True
    except OSError:return False
def closed():
    for _ in range(40):
        if not listening():return
        time.sleep(.1)
    raise AssertionError('Local helper outlived its owner')
assert not listening(),'Stop the local preview room before this check; never kill an unrelated host.'
# Ordinary launches now show the title without starting a room.
normal_log=EVIDENCE/'local-default-launch.log'
with normal_log.open('w') as out:
    result=subprocess.run([str(APP),'--headless','--quit-after','120'],stdout=out,stderr=subprocess.STDOUT,timeout=20)
assert result.returncode==0,normal_log.read_text()
assert 'TITLE_READY menu=true connected=false local_helper=-1' in normal_log.read_text(),normal_log.read_text()
assert not listening(),'Title screen started a room before Start game'
with (EVIDENCE/'local-cold-start.log').open('w') as out:
    result=subprocess.run([str(APP),'--headless','--','--qa-local'],stdout=out,stderr=subprocess.STDOUT,timeout=45)
assert result.returncode==0,(EVIDENCE/'local-cold-start.log').read_text()
assert 'LOCAL_STARTUP_RESULT cold_start=true keyboard_walk=true restart=true reconnect=true click_route=true' in (EVIDENCE/'local-cold-start.log').read_text()
closed()
owner_log=EVIDENCE/'local-owner.log'
with owner_log.open('w') as out:
    owner=subprocess.Popen([str(APP),'--headless','--','--qa-host'],stdout=out,stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            if listening():break
            assert owner.poll() is None,owner_log.read_text()
            time.sleep(.1)
        assert listening(),owner_log.read_text()
        with (EVIDENCE/'local-reuse.log').open('w') as guest_log:
            guest=subprocess.run([str(APP),'--headless','--','--qa-reuse','--server=ws://localhost:28765'],stdout=guest_log,stderr=subprocess.STDOUT,timeout=20)
        assert guest.returncode==0,(EVIDENCE/'local-reuse.log').read_text()
        assert 'LOCAL_REUSE_RESULT reused=true' in (EVIDENCE/'local-reuse.log').read_text()
        assert owner.poll() is None and listening(),'Guest incorrectly stopped owner room'
    finally:
        owner.terminate()
        owner.wait(timeout=5)
closed()
for log in ['local-default-launch.log','local-cold-start.log','local-owner.log','local-reuse.log']:
    assert 'ERROR:' not in (EVIDENCE/log).read_text(),(EVIDENCE/log).read_text()
print('PASS: ordinary launch shows title without starting a room; exported app cold-start, keyboard/click walking, server recovery, localhost reuse, and owner-only lifetime')
