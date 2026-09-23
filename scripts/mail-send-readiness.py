"""Probe an explicitly supplied Mail source with disposable state and intercepted SMTP."""
import base64
import hashlib
import importlib.util
import json
import mailbox
import pathlib
import socket
import sqlite3
import sys
import tempfile
from unittest.mock import patch

source = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(source / 'ops'))
# No live network is permitted even if a tested path changes unexpectedly.
def no_network(*args, **kwargs):
    raise AssertionError('Readiness probe attempted a real network connection')

with patch.object(socket.socket, 'connect', no_network), patch.object(socket, 'create_connection', no_network):
    spec = importlib.util.spec_from_file_location('mail_send_probe', source / 'ops/mail-connector.py')
    connector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(connector)
    import mail_managed
    with tempfile.TemporaryDirectory(prefix='ai-mail-send-readiness-') as temporary:
        root = pathlib.Path(temporary)
        box = mailbox.Maildir(root / 'Maildir', create=True)
        wallet = '0x' + '1' * 40
        address = 'synthetic@bittrees.org'
        conf = {'address': address, 'wallets': {wallet: [address]}, 'maildir': str(root / 'Maildir')}
        payload = {'to': 'recipient@bittrees.org', 'subject': 'Synthetic review', 'text': 'Synthetic body',
                   'idempotencyKey': 'synthetic-send-readiness-01',
                   'attachments': [{'filename': 'fixture.bin', 'content': base64.b64encode(b'exact bytes').decode()}]}
        effects = []
        lose_response = False
        class InterceptedSMTP:
            def __init__(self, *args, **kwargs):
                assert args == ('127.0.0.1', 25)
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def send_message(self, message, *, from_addr, to_addrs):
                assert from_addr == address and to_addrs == [payload['to']]
                effects.append(message)
                if lose_response:
                    raise TimeoutError('Synthetic response loss after possible SMTP acceptance')
                return {}
        def dispatch(p=payload, route='/send', who=wallet):
            return connector.handle({'wallet': who, 'mailbox': address, 'route': route, 'payload': p}, conf)
        def denied(fn, status):
            try: fn()
            except connector.MailError as e: assert e.status == status
            else: raise AssertionError('Expected source denial')
        with patch.object(mail_managed, 'MANAGED', root / 'managed.json'), patch.object(connector, 'STATE', root), patch.object(connector.smtplib, 'SMTP', InterceptedSMTP):
            assert dispatch() == {'ok': True}
            assert dispatch() == {'ok': True} and len(effects) == 1
            message = effects[0]
            assert message['From'] == address and message['To'] == payload['to']
            assert message.get('Cc') is None and message.get('Bcc') is None
            attachment = list(message.iter_attachments())[0]
            assert attachment.get_filename() == 'fixture.bin'
            assert attachment.get_payload(decode=True) == b'exact bytes'
            for change in [{'to': 'changed@bittrees.org'}, {'subject': 'changed'}, {'text': 'changed'},
                           {'attachments': [{'filename': 'changed.bin', 'content': 'eA=='}]}]:
                denied(lambda: dispatch({**payload, **change}), 409)
            assert len(effects) == 1
            denied(lambda: dispatch(who='0x' + '2' * 40), 403)
            # No receipt/status query exists in this pinned source. Do not use a send retry as a read.
            for route in ['/send-status/' + payload['idempotencyKey'], '/send-receipts/' + payload['idempotencyKey']]:
                denied(lambda: dispatch(None, route), 404)
            lose_response = True
            uncertain = {**payload, 'idempotencyKey': 'synthetic-send-readiness-02'}
            try: dispatch(uncertain)
            except TimeoutError: pass
            else: raise AssertionError('Expected intercepted uncertain send')
            assert len(effects) == 2
            denied(lambda: dispatch(uncertain), 409)
            assert len(effects) == 2
            with sqlite3.connect(root / 'sent.sqlite') as db:
                assert db.execute('SELECT status FROM sent ORDER BY id').fetchall() == [('accepted',), ('pending',)]
                assert db.execute('SELECT count(*) FROM sent').fetchone()[0] == 2
            # Exercise the actual local mapping resolver with a frozen account.
            (root / 'managed.json').write_text(json.dumps({'updated': __import__('time').time(), 'mailboxes': {
                address: {'status': 'frozen', 'maildir': str(root / 'Maildir'), 'wallets': [wallet]}}}))
            denied(lambda: dispatch(), 403)
            assert len(effects) == 2
        box.close()
        print(json.dumps({'status': 'passed', 'interceptedSmtpAttempts': len(effects), 'realSmtpCalls': 0,
            'checks': ['mapped From and exact attachment bytes', 'accepted duplicate has one effect',
                       'changed recipient, subject, body or attachment cannot reuse the operation ID',
                       'foreign wallet and frozen local mapping denied',
                       'possible SMTP acceptance with lost response retains pending and cannot resend',
                       'historical accepted and uncertain pending remain distinct in durable source storage'],
            'gaps': ['no read-only operation receipt route', 'legacy response is only ok; it is not delivery confirmation'],
            'personalDataUsed': False, 'acerContacted': False}))
