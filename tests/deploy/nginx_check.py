#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Validate the rendered deploy templates on a throwaway stack, as an unprivileged user.

What it does (nothing outside .throwaway/ is written, no system service is touched):

 1. renders deploy/ with deploy/vars.example.env into .throwaway/deploy-render/example/;
 2. renders it again with test values (ports 15310-15319 / 18090-18099, directories below the
    run directory) into .throwaway/deploy-render/test/;
 3. `nginx -t` on a test nginx.conf that includes the rendered snippets, and on the complete
    rendered example vhost (with a throwaway self-signed certificate);
 4. starts a throwaway Radicale (configuration built from the rendered config snippet, the real
    rights plugin), the real backend (rendered config.toml) and an unprivileged nginx in front;
 5. checks with HTTP requests: static files, media types, the security headers of EVERY location,
    loopback-only health, the Radicale proxy, spoofed address headers (real stack: Radicale log and
    backend audit; echo stack: the exact headers each upstream receives), body-size limit, rate
    limit;
 6. stops everything and removes the run directory.

Run it under `timeout`:  timeout 300 python3 -I tests/deploy/nginx_check.py
Environment: RADICALE_BIN (or .env.local), NGINX_BIN (default: nginx on PATH or /usr/sbin/nginx),
NGINX_MIME_TYPES (default /etc/nginx/mime.types, read only).
Exit status 0 when every check passes, 1 otherwise, 77 when nginx or Radicale is missing.
"""
import configparser
import grp
import http.client
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "tools"))

RADICALE_PORT, BACKEND_PORT, ECHO_RAD_PORT, ECHO_API_PORT = 15310, 15311, 15312, 15313
NGINX_PORT, NGINX_ECHO_PORT = 18090, 18091
HOST = "example.org"
SPOOF_IP = "203.0.113.9"
# Other loopback addresses used as client sources (the whole IPv4 loopback block is local on Linux).
SRC_DENIED = "127.0.0." + "2"  # health must refuse any address but the loopback address itself
SRC_LIMITED = "127.0.0." + "3"  # the address the rate-limit test uses up
SRC_OTHER = "127.0.0." + "4"  # an address the limit must not affect
EXPECTED_CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
                "manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
                "form-action 'none'")
BASELINE = ["strict-transport-security", "x-content-type-options", "x-frame-options",
            "referrer-policy", "permissions-policy"]

RESULTS = []


def check(ok, name, detail=""):
    RESULTS.append(bool(ok))
    print("%s  %s%s" % ("PASS" if ok else "FAIL", name, ("  [" + detail + "]") if detail else ""),
          flush=True)
    return ok


def info(text):
    print("INFO  " + text, flush=True)


def find_nginx():
    for cand in (os.environ.get("NGINX_BIN"), shutil.which("nginx"), "/usr/sbin/nginx"):
        if cand and os.access(cand, os.X_OK):
            return cand
    return None


def find_radicale():
    cand = os.environ.get("RADICALE_BIN")
    if not cand:
        try:
            with open(os.path.join(REPO, ".env.local")) as fh:
                for line in fh:
                    if line.startswith("RADICALE_BIN="):
                        cand = line.split("=", 1)[1].strip().strip('"')
        except OSError:
            pass
    cand = cand or shutil.which("radicale")
    if cand and os.access(cand, os.X_OK):
        return cand
    return None


def radicale_python(radicale_bin):
    with open(radicale_bin, "rb") as fh:
        first = fh.readline().decode(errors="replace").strip()
    return first[2:].split()[0] if first.startswith("#!") else sys.executable


# ---- small HTTP client ---------------------------------------------------------------------------

class Resp:
    def __init__(self, status, pairs, body):
        self.status, self.pairs, self.body = status, pairs, body

    def all(self, name):
        return [v for k, v in self.pairs if k.lower() == name.lower()]

    def one(self, name):
        vals = self.all(name)
        return vals[0] if len(vals) == 1 else None


def request(port, method, path, headers=None, body=None, source=None, timeout=15):
    h = {"Host": HOST}
    h.update(headers or {})
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout,
                                      source_address=(source, 0) if source else None)
    try:
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for k, v in h.items():
            conn.putheader(k, v)
        if body is not None:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders()
        if body is not None:
            try:
                conn.send(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # nginx may answer 413 and close before the body is fully sent
        r = conn.getresponse()
        return Resp(r.status, r.getheaders(), r.read())
    finally:
        conn.close()


# ---- echo upstream -------------------------------------------------------------------------------

class Echo(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _echo(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        data = json.dumps({"method": self.command, "path": self.path,
                           "headers": [[k, v] for k, v in self.headers.items()]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_PROPFIND = do_DELETE = do_REPORT = _echo


def start_echo(port):
    srv = ThreadingHTTPServer(("127.0.0.1", port), Echo)
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


# ---- setup ---------------------------------------------------------------------------------------

def port_free(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def wait_port(port, seconds=30):
    t0 = time.time()
    while time.time() - t0 < seconds:
        if not port_free(port):
            return True
        time.sleep(0.1)
    return False


def read_vars(path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("render_deploy", os.path.join(REPO, "tools", "render-deploy.py"))
    rd = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rd)
    with open(path) as fh:
        values, _doc = rd.parse_vars(fh.read(), path)
    return rd, values


def write_vars(path, values):
    with open(path, "w") as fh:
        for k, v in values.items():
            fh.write("# %s\n%s=%s\n" % (k, k, v))


def render(rd, values, out):
    rendered = rd.render_tree(os.path.join(REPO, "deploy"), values)
    shutil.rmtree(out, ignore_errors=True)
    rd.write_tree(out, rendered)
    return rendered


def nginx_conf(run, rendered_dir, snippets, port, extra_http="", server_extra=""):
    mime = os.environ.get("NGINX_MIME_TYPES", "/etc/nginx/mime.types")
    return """\
worker_processes 1;
pid {run}/nginx-{port}.pid;
error_log {run}/nginx-{port}.error.log notice;
events {{ worker_connections 64; }}
http {{
    include {mime};
    default_type application/octet-stream;
    include {snippets}/radui-http.conf;
    access_log {run}/nginx-{port}.access.log;
    client_body_temp_path {run}/tmp-{port}/client_body;
    proxy_temp_path {run}/tmp-{port}/proxy;
    fastcgi_temp_path {run}/tmp-{port}/fastcgi;
    uwsgi_temp_path {run}/tmp-{port}/uwsgi;
    scgi_temp_path {run}/tmp-{port}/scgi;
    server_tokens off;
{extra_http}
    server {{
        listen 127.0.0.1:{port};
        server_name {host};
        include {snippets}/radui-security-headers.inc;
        include {snippets}/radui-locations.conf;
{server_extra}
    }}
}}
""".format(run=run, mime=mime, snippets=snippets, port=port, host=HOST,
           extra_http=extra_http, server_extra=server_extra)


def main():
    nginx = find_nginx()
    rad_bin = find_radicale()
    if not nginx or not rad_bin:
        print("nginx or Radicale not found: skipping", file=sys.stderr)
        return 77
    for p in (RADICALE_PORT, BACKEND_PORT, ECHO_RAD_PORT, ECHO_API_PORT, NGINX_PORT, NGINX_ECHO_PORT):
        if not port_free(p):
            print("port %d is in use" % p, file=sys.stderr)
            return 2

    base = os.path.join(REPO, ".throwaway")
    render_root = os.path.join(base, "deploy-render")
    run = os.path.join(base, "deploy-run")
    shutil.rmtree(run, ignore_errors=True)
    os.makedirs(run, mode=0o700)
    procs = []
    servers = []
    try:
        return _run(nginx, rad_bin, render_root, run, procs, servers)
    finally:
        for srv in servers:
            srv.shutdown()
            srv.server_close()
        for pidfile in [os.path.join(run, n) for n in os.listdir(run) if n.endswith(".pid")] if os.path.isdir(run) else []:
            try:
                with open(pidfile) as fh:
                    os.kill(int(fh.read().strip()), signal.SIGQUIT)
            except (OSError, ValueError):
                pass
        for p in procs:
            if p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                    p.wait(10)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    try:
                        os.killpg(p.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        time.sleep(0.5)
        shutil.rmtree(run, ignore_errors=True)


def _run(nginx, rad_bin, render_root, run, procs, servers):
    rd, example = read_vars(os.path.join(REPO, "deploy", "vars.example.env"))

    # 1. example values
    ex_out = os.path.join(render_root, "example")
    ex_rendered = render(rd, example, ex_out)
    check(len(ex_rendered) >= 10 and not any("@@" in t for t in ex_rendered.values()),
          "render with deploy/vars.example.env", "%d files in %s" % (len(ex_rendered), os.path.relpath(ex_out, REPO)))

    # 2. test values
    www = os.path.join(run, "www")
    snippets = os.path.join(run, "snippets")
    managed, state, confdir = (os.path.join(run, n) for n in ("managed", "state", "config"))
    plugin_dir = os.path.join(REPO, "backend", "plugin")
    group = grp.getgrgid(os.getgid()).gr_name
    test = dict(example)
    test.update({
        "UI_DIR": www, "NGINX_SNIPPETS_DIR": snippets, "MANAGED_DIR": managed, "STATE_DIR": state,
        "CONFIG_DIR": confdir, "PLUGIN_DIR": plugin_dir, "INSTALL_DIR": os.path.join(REPO, "backend"),
        "BACKEND_LISTEN": "127.0.0.1:%d" % BACKEND_PORT, "RADICALE_UPSTREAM": "127.0.0.1:%d" % RADICALE_PORT,
        "RADICALE_GROUP": group, "RADICALE_PYTHON": radicale_python(rad_bin),
        "API_RATE": "30r/m", "API_BURST": "5", "RADICALE_MAX_BODY": "2M",
        "TLS_CERT": os.path.join(run, "cert.pem"), "TLS_KEY": os.path.join(run, "key.pem"),
    })
    te_out = os.path.join(render_root, "test")
    te = render(rd, test, te_out)
    check(True, "render with test values", os.path.relpath(te_out, REPO))

    # snippets in place, throwaway web root from src/ plus the files the app will have later
    os.makedirs(snippets)
    for f in ("radui-http.conf", "radui-security-headers.inc", "radui-proxy-headers.inc", "radui-locations.conf"):
        shutil.copy(os.path.join(te_out, "nginx", f), snippets)
    shutil.copytree(os.path.join(REPO, "src"), www, ignore=shutil.ignore_patterns("vendor"))
    for name, data in (("sw.js", "// service worker placeholder\n"),
                       ("sw-manifest.js", "// service worker file list placeholder\n"),
                       ("manifest.webmanifest", '{"name":"RadUI"}\n'),
                       ("probe.mjs", "export default 1;\n"),
                       ("probe.ics", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"),
                       ("probe.vcf", "BEGIN:VCARD\r\nEND:VCARD\r\n")):
        with open(os.path.join(www, name), "w") as fh:
            fh.write(data)
    for p in (NGINX_PORT, NGINX_ECHO_PORT):
        os.makedirs(os.path.join(run, "tmp-%d" % p))

    # 3. nginx -t
    conf = os.path.join(run, "nginx-%d.conf" % NGINX_PORT)
    with open(conf, "w") as fh:
        fh.write(nginx_conf(run, te_out, snippets, NGINX_PORT))
    r = subprocess.run([nginx, "-t", "-c", conf, "-p", run + "/", "-e", os.path.join(run, "t.err")],
                       capture_output=True, text=True, timeout=30)
    check(r.returncode == 0, "nginx -t on the rendered snippets (test nginx.conf)", (r.stderr.strip().splitlines() or [""])[-1])

    # full example vhost: needs a certificate; listen 80/443 are privileged ports, so only -t is run
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=" + HOST,
                    "-keyout", test["TLS_KEY"], "-out", test["TLS_CERT"]], capture_output=True, timeout=60)
    vhost = os.path.join(te_out, "nginx", "radui-vhost-example.conf")
    vconf = os.path.join(run, "nginx-vhost.conf")
    mime = os.environ.get("NGINX_MIME_TYPES", "/etc/nginx/mime.types")
    with open(vconf, "w") as fh:
        fh.write("worker_processes 1;\npid %s/vhost.pid;\nerror_log %s/vhost.err notice;\nevents { worker_connections 8; }\n"
                 "http {\n access_log %s/vhost.access.log;\n include %s;\n include %s/radui-http.conf;\n client_body_temp_path %s/tmp-v/c;\n proxy_temp_path %s/tmp-v/p;\n"
                 " fastcgi_temp_path %s/tmp-v/f;\n uwsgi_temp_path %s/tmp-v/u;\n scgi_temp_path %s/tmp-v/s;\n include %s;\n}\n"
                 % (run, run, run, mime, snippets, run, run, run, run, run, vhost))
    os.makedirs(os.path.join(run, "tmp-v"))
    r = subprocess.run([nginx, "-t", "-c", vconf, "-p", run + "/", "-e", os.path.join(run, "v.err")],
                       capture_output=True, text=True, timeout=30)
    # nginx -t also tries to bind the listen sockets: an unprivileged user cannot bind 80/443, so
    # the verbatim file is judged on "syntax is ok" plus the single expected bind error, and a copy
    # with only the listen lines moved to high ports must pass completely.
    only_bind = r.returncode != 0 and "syntax is ok" in r.stderr and r.stderr.count("[emerg]") == 1 and "bind() to" in r.stderr
    check("syntax is ok" in r.stderr and (r.returncode == 0 or only_bind),
          "nginx -t on the complete rendered example vhost as rendered (syntax ok; port 80/443 bind refused to an unprivileged user)",
          " | ".join(r.stderr.strip().splitlines()[-2:])[:160])
    with open(vhost) as fh:
        vtext = fh.read()
    vtext = vtext.replace("listen 80;", "listen 127.0.0.1:18095;").replace("listen 443 ssl;", "listen 127.0.0.1:18096 ssl;")
    vtext = "\n".join(l for l in vtext.splitlines() if "listen [::]" not in l) + "\n"
    vhost_hi = os.path.join(run, "vhost-highports.conf")
    with open(vhost_hi, "w") as fh:
        fh.write(vtext)
    subprocess.run(["sed", "-i", "s|include %s;|include %s;|" % (vhost, vhost_hi), vconf], check=True)
    r = subprocess.run([nginx, "-t", "-c", vconf, "-p", run + "/", "-e", os.path.join(run, "v.err")],
                       capture_output=True, text=True, timeout=30)
    check(r.returncode == 0, "nginx -t on the same vhost with only the listen ports moved to 18095/18096 (TLS, all locations)",
          (r.stderr.strip().splitlines() or [""])[-1][-100:])

    # 4. stack: Radicale (config from the rendered snippet), backend, nginx
    os.makedirs(managed, mode=0o750)
    snippet = configparser.ConfigParser(interpolation=None)
    snippet.read(os.path.join(te_out, "radicale", "config-snippet.ini"))
    check(snippet.get("rights", "type") == "radui_rights"
          and snippet.get("rights", "permit_delete_collection") == "False"
          and snippet.get("rights", "permit_overwrite_collection") == "False"
          and snippet.get("auth", "htpasswd_filename") == managed + "/users"
          and snippet.get("rights", "file") == managed + "/rights",
          "rendered Radicale snippet has the rights/auth settings the plugin README requires")
    rad_conf = configparser.ConfigParser(interpolation=None)
    rad_conf.read_dict({s: dict(snippet.items(s)) for s in snippet.sections()})
    rad_conf["server"]["hosts"] = "127.0.0.1:%d" % RADICALE_PORT
    rad_conf["storage"] = {"filesystem_folder": os.path.join(run, "collections")}
    rad_conf["auth"]["delay"] = "0"
    rad_conf["logging"]["level"] = "warning"
    rad_conf_path = os.path.join(run, "radicale.conf")
    with open(rad_conf_path, "w") as fh:
        rad_conf.write(fh)

    # legacy files -> import (creates generation 1: managed/users, managed/rights, state/)
    import bcrypt
    pw = {"alice": "alice-pass-" + os.urandom(6).hex(), "agent-1": "agent-pass-" + os.urandom(6).hex()}
    legacy_users = os.path.join(run, "legacy-users")
    with open(legacy_users, "w") as fh:
        for k, v in pw.items():
            fh.write("%s:%s\n" % (k, bcrypt.hashpw(v.encode(), bcrypt.gensalt(4)).decode()))
    legacy_rights = os.path.join(run, "legacy-rights")
    with open(legacy_rights, "w") as fh:
        fh.write("[root]\nuser: .+\ncollection:\npermissions: R\n\n[principal]\nuser: .+\ncollection: {user}\n"
                 "permissions: RW\n\n[own]\nuser: .+\ncollection: {user}/[^/]+\npermissions: rw\n")
    os.makedirs(confdir, mode=0o755)
    cfg_path = os.path.join(confdir, "config.toml")
    shutil.copy(os.path.join(te_out, "backend", "config.toml"), cfg_path)
    os.chmod(cfg_path, 0o600)
    cli = [sys.executable, "-I", os.path.join(REPO, "backend", "bin", "radui-admin-cli"), "--config", cfg_path]
    r = subprocess.run(cli + ["import", "--admin", "alice", "--users", legacy_users, "--rights", legacy_rights],
                       capture_output=True, text=True, timeout=120)
    check(r.returncode == 0, "radui-admin-cli import with the rendered config.toml", (r.stdout + r.stderr).strip().splitlines()[-1][:100] if (r.stdout + r.stderr).strip() else "")
    if r.returncode != 0:
        print(r.stdout, r.stderr)
        return 1

    env = dict(os.environ)
    env["PYTHONPATH"] = plugin_dir
    rlog = open(os.path.join(run, "radicale.log"), "wb")
    procs.append(subprocess.Popen([rad_bin, "--config", rad_conf_path], env=env, stdout=rlog, stderr=subprocess.STDOUT,
                                  stdin=subprocess.DEVNULL, start_new_session=True))
    bout = open(os.path.join(run, "backend.out"), "wb")
    berr = open(os.path.join(run, "backend.err"), "wb")
    procs.append(subprocess.Popen([sys.executable, "-I", os.path.join(REPO, "backend", "bin", "radui-admin"), "--config", cfg_path],
                                  stdout=bout, stderr=berr, stdin=subprocess.DEVNULL, start_new_session=True))
    servers.append(start_echo(ECHO_RAD_PORT))
    servers.append(start_echo(ECHO_API_PORT))
    check(wait_port(RADICALE_PORT) and wait_port(BACKEND_PORT), "throwaway Radicale and the real backend are up")
    subprocess.run([nginx, "-c", conf, "-p", run + "/", "-e", os.path.join(run, "nginx-%d.error.log" % NGINX_PORT)], check=True, timeout=30)

    # echo-stack nginx: same templates, both upstreams replaced by echo servers
    echo_vars = dict(test)
    echo_vars.update({"BACKEND_LISTEN": "127.0.0.1:%d" % ECHO_API_PORT, "RADICALE_UPSTREAM": "127.0.0.1:%d" % ECHO_RAD_PORT})
    echo_out = os.path.join(render_root, "echo")
    echo_rendered = render(rd, echo_vars, echo_out)
    esn = os.path.join(run, "snippets-echo")
    os.makedirs(esn)
    for f in ("radui-http.conf", "radui-security-headers.inc", "radui-proxy-headers.inc", "radui-locations.conf"):
        with open(os.path.join(esn, f), "w") as fh:
            fh.write(echo_rendered["nginx/" + f])
    econf = os.path.join(run, "nginx-%d.conf" % NGINX_ECHO_PORT)
    with open(econf, "w") as fh:
        fh.write(nginx_conf(run, echo_out, esn, NGINX_ECHO_PORT))
    subprocess.run([nginx, "-c", econf, "-p", run + "/", "-e", os.path.join(run, "nginx-%d.error.log" % NGINX_ECHO_PORT)], check=True, timeout=30)
    check(wait_port(NGINX_PORT) and wait_port(NGINX_ECHO_PORT), "unprivileged nginx instances are up (ports %d, %d)" % (NGINX_PORT, NGINX_ECHO_PORT))

    N = NGINX_PORT
    basic = lambda u, p: "Basic " + __import__("base64").b64encode(("%s:%s" % (u, p)).encode()).decode()  # noqa: E731

    # ---- static files and media types -----------------------------------------------------------
    r = request(N, "GET", "/ui/")
    check(r.status == 200 and (r.one("content-type") or "").startswith("text/html"), "GET /ui/ serves the app", "%s %s" % (r.status, r.one("content-type")))
    check(r.one("content-security-policy") == EXPECTED_CSP, "CSP of /ui/ is exactly the policy of SPECS 3 + 6a")
    for path, want in (("/ui/probe.mjs", "text/javascript"), ("/ui/manifest.webmanifest", "application/manifest+json"),
                       ("/ui/probe.ics", "text/calendar"), ("/ui/probe.vcf", "text/vcard"), ("/ui/js/app.js", ("text/javascript", "application/javascript")),
                       ("/ui/css/app.css", "text/css"), ("/ui/icons/favicon.svg", "image/svg+xml")):
        r = request(N, "GET", path)
        ctype = (r.one("content-type") or "").split(";")[0]
        check(r.status == 200 and ctype in ((want,) if isinstance(want, str) else want), "media type of %s" % path, "%s %s" % (r.status, ctype))
    for path, want in (("/ui/index.html", "no-cache"), ("/ui/config.json", "no-cache"), ("/ui/sw.js", "no-cache"),
                       ("/ui/sw-manifest.js", "no-cache"), ("/ui/manifest.webmanifest", "no-cache"), ("/ui/", "no-cache"), ("/ui/js/app.js", "public, max-age=300")):
        r = request(N, "GET", path)
        check(r.all("cache-control") == [want], "Cache-Control of %s is exactly %r" % (path, want), str(r.all("cache-control")))
    r = request(N, "GET", "/ui")
    check(r.status == 301 and r.one("location") == "/ui/", "GET /ui redirects to /ui/ (relative Location)", "%s %s" % (r.status, r.one("location")))

    # ---- security headers on every location -----------------------------------------------------
    # (name, method, path, headers, source address)
    locs = [
        ("redirect /ui", "GET", "/ui", {}, None),
        ("static /ui/", "GET", "/ui/", {}, None),
        ("static /ui/js/app.js", "GET", "/ui/js/app.js", {}, None),
        ("static 404", "GET", "/ui/nope.js", {}, None),
        ("exact /ui/index.html", "GET", "/ui/index.html", {}, None),
        ("exact /ui/config.json", "GET", "/ui/config.json", {}, None),
        ("exact /ui/sw.js", "GET", "/ui/sw.js", {}, None),
        ("exact /ui/sw-manifest.js", "GET", "/ui/sw-manifest.js", {}, None),
        ("exact /ui/manifest.webmanifest", "GET", "/ui/manifest.webmanifest", {}, None),
        ("api /ui/api/me (anonymous)", "GET", "/ui/api/me", {}, None),
        ("api health (loopback)", "GET", "/ui/api/health", {}, None),
        ("api health (denied, another source address)", "GET", "/ui/api/health", {}, SRC_DENIED),
        ("api too large (413)", "POST", "/ui/api/accounts", {"Content-Type": "application/json"}, None),
        ("radicale PROPFIND / (401)", "PROPFIND", "/", {"Depth": "0"}, None),
        ("radicale /.web/", "GET", "/.web/", {}, None),
        ("radicale 404 path", "GET", "/nobody/none/", {}, None),
    ]
    matrix = []
    for name, method, path, hdr, src in locs:
        body = b"x" * 20000 if "413" in name else None
        r = request(N, method, path, hdr, body=body, source=src)
        vals = {h: r.all(h) for h in BASELINE}
        csp = r.all("content-security-policy")
        matrix.append((name, r.status, vals, csp))
    ref = matrix[1][2]
    all_present = all(all(len(v[h]) == 1 for h in BASELINE) for _n, _s, v, _c in matrix)
    check(all_present, "every location sends each of the 5 baseline security headers exactly once (%d locations)" % len(matrix),
          "; ".join("%s=%s" % (n, s) for n, s, _v, _c in matrix))
    check(all(v == ref for _n, _s, v, _c in matrix), "the baseline header VALUES are identical in every location")
    print("      location                                 status  baseline-set  CSP")
    for n, s, v, c in matrix:
        print("      %-40s %-7s %-13s %s" % (n, s, "complete" if all(len(v[h]) == 1 for h in BASELINE) else "INCOMPLETE",
                                            "app policy" if c == [EXPECTED_CSP] else ("backend: " + c[0] if c else "none")))
    check(all(c == [EXPECTED_CSP] for n, _s, _v, c in matrix if n.startswith(("static", "exact"))),
          "every static location carries the app CSP exactly once")
    check(all(c == [EXPECTED_CSP] for n, _s, _v, c in matrix if n.startswith("radicale")), "the Radicale location carries the app CSP exactly once")
    check(all(c == ["default-src 'none'"] for n, _s, _v, c in matrix if n.startswith("api") and "denied" not in n and "413" not in n),
          "the API answers carry only the backend's own CSP (default-src 'none'), once")
    r = request(N, "GET", "/ui/api/me")
    check(r.all("cache-control") == ["no-store"] and r.status == 401 and not r.all("www-authenticate"),
          "API: single Cache-Control no-store, 401 without WWW-Authenticate", "%s %s" % (r.status, r.all("cache-control")))

    # ---- health ---------------------------------------------------------------------------------
    r = request(N, "GET", "/ui/api/health")
    try:
        hb = json.loads(r.body)
    except ValueError:
        hb = {}
    check(r.status == 200 and "generation" in hb, "GET /ui/api/health reachable from loopback", "%s %s" % (r.status, r.body[:80].decode(errors="replace")))
    r = request(N, "GET", "/ui/api/health", source=SRC_DENIED)
    check(r.status == 403, "GET /ui/api/health refused from any other address (another source address)", str(r.status))
    check(all(request(N, "GET", "/ui/api/health").status == 200 for _ in range(15)), "health is not rate limited (15 quick calls)")

    # ---- Radicale proxy -------------------------------------------------------------------------
    r = request(N, "PROPFIND", "/", {"Depth": "0"})
    check(r.status == 401 and r.one("www-authenticate") is not None, "PROPFIND / without credentials reaches Radicale: 401 + WWW-Authenticate", str(r.status))
    r = request(N, "PROPFIND", "/alice/", {"Depth": "0", "Authorization": basic("alice", pw["alice"])})
    check(r.status == 207, "PROPFIND /alice/ with credentials: 207 through nginx", str(r.status))
    r = request(N, "GET", "/ui/api/me", {"Authorization": basic("alice", pw["alice"]), "Origin": "https://" + HOST, "Sec-Fetch-Site": "same-origin"})
    try:
        me = json.loads(r.body)
    except ValueError:
        me = {}
    check(r.status == 200 and me.get("login") == "alice" and me.get("admin") is True, "GET /ui/api/me with admin credentials through nginx (backend -> Radicale)", "%s %s" % (r.status, me.get("login")))

    # ---- spoofed headers: real stack -------------------------------------------------------------
    spoof = {"X-Forwarded-For": SPOOF_IP, "X-Real-IP": "203.0.113.10", "X-Forwarded-Host": "evil.example.net",
             "X-Remote-Addr": "203.0.113.8", "Forwarded": "for=203.0.113.7"}
    request(N, "PROPFIND", "/alice/", dict(spoof, Depth="0", Authorization=basic("alice", "wrong-" + os.urandom(4).hex())))
    request(N, "GET", "/ui/api/me", dict(spoof, Authorization=basic("alice", "wrong-" + os.urandom(4).hex()), Origin="https://" + HOST, **{"Sec-Fetch-Site": "same-origin"}))
    time.sleep(1.0)
    with open(os.path.join(run, "radicale.log"), errors="replace") as fh:
        rlogtext = fh.read()
    failed = [l for l in rlogtext.splitlines() if "Failed login attempt" in l]
    check(len(failed) >= 2 and all("(forwarded for '127.0.0.1')" in l for l in failed) and "203.0.113" not in rlogtext
          and "evil.example.net" not in rlogtext,
          "real Radicale logs the nginx-seen address, never the spoofed one",
          "e.g. " + (failed[0].split("] ", 2)[-1][:90] if failed else "no failed-login line"))
    if failed:
        info("real Radicale log line: " + failed[0])
    with open(os.path.join(run, "backend.out"), errors="replace") as fh:
        audit = [json.loads(l) for l in fh if l.startswith("{")]
    auth_failed = [a for a in audit if a.get("event") == "auth.failed"]
    check(auth_failed and all(a.get("ip") == "127.0.0.1" for a in auth_failed) and "203.0.113" not in json.dumps(audit),
          "real backend audit records the nginx-seen address, never the spoofed X-Real-IP / X-Forwarded-For",
          "ip=%s" % (auth_failed[-1].get("ip") if auth_failed else "no auth.failed event"))

    # ---- spoofed headers: echo stack (exact headers each upstream receives) -----------------------
    E = NGINX_ECHO_PORT
    for name, method, path in (("Radicale location", "PROPFIND", "/alice/"), ("API location", "GET", "/ui/api/me"),
                               ("health location", "GET", "/ui/api/health")):
        r = request(E, method, path, dict(spoof, **{"X-Forwarded-Port": "9999", "X-Forwarded-Server": "evil", "X-Remote-User": "alice",
                                                    "X-Script-Name": "/evil"}))
        got = [(k.lower(), v) for k, v in json.loads(r.body)["headers"]]
        names = [k for k, _v in got]
        d = dict(got)
        ok = (d.get("x-forwarded-for") == "127.0.0.1" and names.count("x-forwarded-for") == 1
              and d.get("x-real-ip") == "127.0.0.1" and names.count("x-real-ip") == 1
              and d.get("host") == HOST and d.get("x-forwarded-proto") == "http"
              and not any(n in names for n in ("x-forwarded-host", "x-forwarded-port", "x-forwarded-server", "x-remote-addr",
                                               "x-remote-user", "x-script-name", "forwarded")))
        check(ok, "%s: upstream receives XFF/X-Real-IP overwritten with the client address, Host set, the 7 trusted-header names cleared" % name,
              "xff=%s real-ip=%s host=%s" % (d.get("x-forwarded-for"), d.get("x-real-ip"), d.get("host")))
    check("203.0.113" not in json.dumps(json.loads(request(E, "GET", "/ui/api/x", spoof).body)), "no spoofed value appears anywhere in the headers the API upstream received")

    # ---- body size ---------------------------------------------------------------------------------
    hdr = {"Content-Type": "application/json", "X-RadUI": "1", "Origin": "https://" + HOST, "Sec-Fetch-Site": "same-origin",
           "Authorization": basic("alice", pw["alice"])}
    r_ok = request(N, "POST", "/ui/api/accounts", hdr, body=b"{" + b" " * 9000 + b"}")
    r_edge = request(N, "POST", "/ui/api/accounts", hdr, body=b"{" + b" " * 16382 + b"}")
    r_big = request(N, "POST", "/ui/api/accounts", hdr, body=b"{" + b" " * 16383 + b"}")
    r_huge = request(N, "POST", "/ui/api/accounts", hdr, body=b"x" * 200000)
    check(r_ok.status not in (413, 502) and r_edge.status not in (413, 502) and r_big.status == 413 and r_huge.status == 413,
          "client_max_body_size 16k on /ui/api/: 9000 and 16384 bytes reach the backend, 16385 and 200000 get 413",
          "%s %s %s %s" % (r_ok.status, r_edge.status, r_big.status, r_huge.status))
    with open(os.path.join(run, "nginx-%d.error.log" % NGINX_PORT), errors="replace") as fh:
        elog = fh.read()
    check("too large body" in elog, "the 413 was produced by nginx (error log: 'client intended to send too large body')")
    big_dav = request(N, "PUT", "/alice/size-probe.ics", {"Authorization": basic("alice", pw["alice"]), "Content-Type": "text/calendar"}, body=b"x" * (3 * 1024 * 1024))
    check(big_dav.status == 413, "the Radicale location uses its own limit (RADICALE_MAX_BODY=2M in the test): 3 MiB PUT gets 413", str(big_dav.status))

    # ---- rate limit (last: it uses a client address of its own) ---------------------------------
    codes = [request(N, "GET", "/ui/api/me", source=SRC_LIMITED).status for _ in range(40)]
    n429 = codes.count(429)
    first429 = codes.index(429) if 429 in codes else -1
    r429 = request(N, "GET", "/ui/api/me", source=SRC_LIMITED)
    check(n429 >= 20 and 5 <= first429 <= 10 and r429.status == 429,
          "rate limit: 40 quick requests from one address (rate 30r/m, burst 5) -> 429 after the burst",
          "first 429 at request #%d, %d x 429, %d x 401" % (first429 + 1, n429, codes.count(401)))
    check(len(r429.all("strict-transport-security")) == 1 and len(r429.all("x-content-type-options")) == 1,
          "a 429 response still carries the security headers")
    check(request(N, "GET", "/ui/api/me", source=SRC_OTHER).status == 401, "another client address is not affected by that limit")
    check(request(N, "GET", "/ui/").status == 200, "the static app is not rate limited")

    # ---- nginx logs --------------------------------------------------------------------------------------
    with open(os.path.join(run, "nginx-%d.error.log" % NGINX_PORT), errors="replace") as fh:
        bad = [l for l in fh if "[emerg]" in l or "[crit]" in l or "[alert]" in l]
    check(not bad, "no emerg/crit/alert line in the nginx error log")

    ok = all(RESULTS)
    print("\n%d checks, %d failed" % (len(RESULTS), RESULTS.count(False)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
