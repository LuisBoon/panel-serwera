#!/usr/bin/env python3
# Pośrednik terminala panelu: uruchamia powłokę w pseudoterminalu i przekazuje dane.
# Wejście (stdin) to ramki: 1 bajt rodzaju ('d' dane / 'r' rozmiar „kolumny wiersze”) + 4 bajty długości + treść.
import os, pty, sys, select, struct, fcntl, termios, signal

def main():
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir('/root')
        os.execvpe('bash', ['bash', '-l'], os.environ)
    buf = b''
    try:
        while True:
            r, _, _ = select.select([fd, 0], [], [])
            if fd in r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                os.write(1, data)
            if 0 in r:
                chunk = os.read(0, 65536)
                if not chunk:
                    break
                buf += chunk
                while len(buf) >= 5:
                    kind = buf[0:1]
                    n = struct.unpack('>I', buf[1:5])[0]
                    if len(buf) < 5 + n:
                        break
                    payload, buf = buf[5:5 + n], buf[5 + n:]
                    if kind == b'd':
                        while payload:
                            k = os.write(fd, payload)
                            payload = payload[k:]
                    elif kind == b'r':
                        try:
                            cols, rows = [max(10, min(500, int(x))) for x in payload.split()]
                            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                        except Exception:
                            pass
    finally:
        try:
            os.killpg(os.getpgid(pid), signal.SIGHUP)
        except Exception:
            pass
        try:
            os.kill(pid, signal.SIGHUP)
        except Exception:
            pass
        try:
            os.waitpid(pid, 0)
        except Exception:
            pass

if __name__ == '__main__':
    main()
