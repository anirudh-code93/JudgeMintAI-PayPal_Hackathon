import { spawn } from 'node:child_process';

// A tiny Model Context Protocol (MCP) client for servers that talk over stdio.
//
// Wire format: one JSON-RPC 2.0 message per line, written to the server's stdin and read from its stdout.
// Conversation:  initialize  ->  (server answers)  ->  notifications/initialized  ->  tools/list, tools/call ...
// No dependencies on purpose: the whole project runs with plain Node.

export class McpError extends Error {
  constructor(message, kind = 'protocol') {
    super(message);
    this.name = 'McpError';
    // spawn: could not start | exit: server stopped | timeout: no answer in time | closed: we shut it down
    // rpc: the server answered with a JSON-RPC error | protocol: anything else
    this.kind = kind;
  }
}

export class McpClient {
  constructor({ command, args = [], env, shell = false, clientInfo = { name: 'judgemintai', version: '1.0.0' }, onExit }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.shell = shell;
    this.clientInfo = clientInfo;
    this.onExit = onExit; // called once if the server stops on its own (not when we close it)
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = '';
    this.dead = false;
    this.failure = null;
    this.serverInfo = null;
  }

  /** Start the server and finish the MCP handshake. Rejects with an McpError (and cleans up) on any problem. */
  async start({ timeoutMs = 60_000 } = {}) {
    const options = { env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
    // On Windows "npx" is really npx.cmd, which Node can only start through a shell. Passing ONE command string
    // (no separate argument list) keeps that safe and avoids Node's shell-arguments warning.
    const child = this.shell
      ? spawn([this.command, ...this.args].join(' '), { ...options, shell: true })
      : spawn(this.command, this.args, options);
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', (chunk) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000); });
    child.stdin.on('error', () => {}); // writing to a dead server is reported through the "exit" event below
    child.on('error', (err) => this._fail(new McpError(`Could not start "${this.command}": ${err.message}`, 'spawn')));
    child.on('exit', (code, signal) => {
      const tail = this.stderrTail.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      this._fail(new McpError(`the MCP server stopped (${signal || `exit code ${code}`})${tail ? `: ${tail}` : ''}`, 'exit'));
    });

    try {
      const init = await this.request('initialize', {
        protocolVersion: '2024-11-05', // the widely supported version; the server may answer with a newer one, which is fine
        capabilities: {},
        clientInfo: this.clientInfo,
      }, timeoutMs);
      this.serverInfo = init?.serverInfo || null;
      this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return init;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /** Send a JSON-RPC request and wait for its answer. */
  request(method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      if (this.dead || !this.child) return reject(this.failure || new McpError('the MCP server is not running', 'closed'));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`${method} timed out after ${Math.round(timeoutMs / 1000)} s`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
      return undefined;
    });
  }

  async listTools() {
    const res = await this.request('tools/list', {}, 20_000);
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  /** Run one tool. Resolves to { isError, text } where text is the server's text answer. */
  async callTool(name, args, { timeoutMs = 30_000 } = {}) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = (Array.isArray(res?.content) ? res.content : [])
      .filter((part) => part && part.type === 'text')
      .map((part) => String(part.text))
      .join('\n');
    return { isError: Boolean(res?.isError), text };
  }

  /** Stop the server (and, on Windows, everything it started). Safe to call more than once. */
  close() {
    const child = this.child;
    this.dead = true;
    this._rejectAll(new McpError('the MCP client was closed', 'closed'));
    if (!child || !child.pid || child.exitCode !== null || child.killed) return; // no pid: it never started
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else child.kill('SIGTERM');
    } catch { /* it already stopped */ }
  }

  _send(message) {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* the "exit" handler reports a dead server */ }
  }

  _fail(err) {
    if (this.dead) return;
    this.dead = true;
    this.failure = err;
    this._rejectAll(err);
    if (this.onExit) this.onExit(err);
  }

  _rejectAll(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  _onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; } // ignore anything that is not protocol traffic
      this._onMessage(message);
    }
    if (this.buffer.length > 5_000_000) this.buffer = ''; // never let a runaway server fill the memory
  }

  _onMessage(message) {
    if (message.method) {
      // The server is asking us something. We only answer "ping"; anything else is politely refused.
      if (message.id !== undefined) {
        this._send(message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
      return; // notifications need no answer
    }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) {
      const err = new McpError(message.error.message || 'the MCP server returned an error', 'rpc');
      err.code = message.error.code;
      waiting.reject(err);
    } else {
      waiting.resolve(message.result);
    }
  }
}
