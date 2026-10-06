#!/usr/bin/env python3
"""Loopback TCP proxy for the simulator walk: 127.0.0.1:<listen> -> 127.0.0.1:<target>.

While <flag-file> exists every new connection is dropped at once, so a UI test can take the
API "offline" and back by creating and removing that file (WalkTestCase.goOffline/goOnline).
usage: api-proxy.py <listen-port> <target-port> <flag-file>
"""
import os, socket, sys, threading

listen, target, flag = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]

def pipe(a, b):
    try:
        while (data := a.recv(65536)):
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass

def serve(client):
    if os.path.exists(flag):
        client.close(); return
    try:
        upstream = socket.create_connection(("127.0.0.1", target), timeout=10)
    except OSError:
        client.close(); return
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()

srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", listen)); srv.listen(64)
while True:
    conn, _ = srv.accept()
    serve(conn)
