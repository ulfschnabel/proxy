#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const PACKAGE_NAME = PACKAGE.name || '@relayplane/proxy';
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const nodeCmd = process.execPath;

const DEPLOY_ROOT = process.env.RELAYPLANE_DEPLOY_DIR || path.join(os.homedir(), '.relayplane', 'deploy');
const BACKUPS_ROOT = path.join(DEPLOY_ROOT, 'backups');
const ARTIFACTS_ROOT = path.join(DEPLOY_ROOT, 'artifacts');
const STAGED_CONFIG = path.join(DEPLOY_ROOT, 'staged-config.json');
const ACTIVE_CONFIG = path.join(os.homedir(), '.relayplane', 'config.json');
const PID_FILE = path.join(os.homedir(), '.relayplane', 'proxy.pid');
const PORT = parseInt(process.env.RELAYPLANE_PROXY_PORT || '4100', 10);
const HOST = process.env.RELAYPLANE_PROXY_HOST || '127.0.0.1';
const HEALTH_URL = `http://${HOST}:${PORT}/health`;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    stdio: options.stdio || 'inherit',
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed${details ? `\n${details}` : ''}`);
  }

  return result.stdout || '';
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed${details ? `\n${details}` : ''}`);
  }

  return (result.stdout || '').trim();
}

function isPortListening() {
  return new Promise((resolve) => {
    const sock = net.connect({ port: PORT, host: HOST });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}

async function waitForPortState(shouldListen, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortListening() === shouldListen) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for port ${PORT} to ${shouldListen ? 'open' : 'close'}`);
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (!body.includes('"status":"ok"')) throw new Error(`Unexpected health response: ${body}`);
      return body;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw lastError || new Error('Health check timed out');
}

function globalInstallRoot() {
  return runCapture(npmCmd, ['root', '-g']);
}

function globalInstallDir() {
  return path.join(globalInstallRoot(), PACKAGE_NAME);
}

function packageJsonPath(root) {
  return path.join(root, 'package.json');
}

function readInstalledVersion() {
  try {
    const data = JSON.parse(fs.readFileSync(packageJsonPath(globalInstallDir()), 'utf8'));
    return data.version || null;
  } catch {
    return null;
  }
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

function copyFileIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return true;
}

function backupCurrentInstall() {
  const name = timestamp();
  const backupDir = path.join(BACKUPS_ROOT, name);
  ensureDir(backupDir);

  const installDir = globalInstallDir();
  if (fs.existsSync(installDir)) {
    copyDir(installDir, path.join(backupDir, 'install'));
  }
  copyFileIfExists(ACTIVE_CONFIG, path.join(backupDir, 'config.json'));
  return backupDir;
}

function restoreBackup(backupName) {
  const backupDir = path.join(BACKUPS_ROOT, backupName);
  const installDir = path.join(backupDir, 'install');
  const configFile = path.join(backupDir, 'config.json');

  if (!fs.existsSync(backupDir)) fail(`Backup not found: ${backupDir}`);

  const targetInstall = globalInstallDir();
  fs.rmSync(targetInstall, { recursive: true, force: true });
  if (fs.existsSync(installDir)) {
    copyDir(installDir, targetInstall);
  }
  copyFileIfExists(configFile, ACTIVE_CONFIG);
}

function packArtifact() {
  ensureDir(ARTIFACTS_ROOT);
  const output = runCapture(npmCmd, ['pack', '--json', '--pack-destination', ARTIFACTS_ROOT], { cwd: REPO_ROOT });
  const parsed = JSON.parse(output);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry?.filename) throw new Error('npm pack did not return an artifact filename');
  return path.join(ARTIFACTS_ROOT, entry.filename);
}

function validate() {
  run(npmCmd, ['test'], { cwd: REPO_ROOT });
  run(npmCmd, ['run', 'build'], { cwd: REPO_ROOT });
}

function stageConfig(sourcePath) {
  const src = sourcePath ? path.resolve(REPO_ROOT, sourcePath) : ACTIVE_CONFIG;
  if (!fs.existsSync(src)) fail(`Config file not found: ${src}`);
  ensureDir(path.dirname(STAGED_CONFIG));
  fs.copyFileSync(src, STAGED_CONFIG);
  return STAGED_CONFIG;
}

function readPid() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const value = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isNaN(value) ? null : value;
  } catch {
    return null;
  }
}

async function stopRunningProxy() {
  const pid = readPid();
  if (!pid) return false;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 0); } catch { return false; }
  }

  try { await waitForPortState(false, 10000); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  return true;
}

async function startProxy() {
  const cliPath = path.join(globalInstallDir(), 'dist', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    throw new Error(`Installed CLI not found: ${cliPath}`);
  }

  const child = spawnSync(nodeCmd, [cliPath, 'supervise', '--port', String(PORT), '--host', HOST], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    encoding: 'utf8',
    shell: false,
    env: process.env,
  });

  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`Failed to start supervised proxy via ${cliPath}`);
  }
}

async function release(opts = {}) {
  if (!opts.skipTests) validate();

  const artifact = packArtifact();
  const backup = backupCurrentInstall();
  const proxyWasRunning = await isPortListening();

  try {
    await stopRunningProxy();
    run(npmCmd, ['install', '-g', artifact], { cwd: REPO_ROOT });

    if (fs.existsSync(STAGED_CONFIG)) {
      ensureDir(path.dirname(ACTIVE_CONFIG));
      fs.copyFileSync(STAGED_CONFIG, ACTIVE_CONFIG);
    }

    if (proxyWasRunning) {
      await startProxy();
      await waitForHealth();
    }

    return {
      ok: true,
      backup,
      artifact,
      version: readInstalledVersion(),
      healthUrl: HEALTH_URL,
      proxyWasRunning,
    };
  } catch (error) {
    try {
      await stopRunningProxy();
      restoreBackup(path.basename(backup));
      if (proxyWasRunning) {
        await startProxy();
      }
    } catch {}
    throw error;
  } finally {
    try { fs.rmSync(artifact, { force: true }); } catch {}
  }
}

function rollback(backupName) {
  if (!backupName) {
    const backups = fs.existsSync(BACKUPS_ROOT)
      ? fs.readdirSync(BACKUPS_ROOT).filter((entry) => fs.statSync(path.join(BACKUPS_ROOT, entry)).isDirectory())
      : [];
    return { ok: false, backups };
  }

  const proxyWasRunning = fs.existsSync(PID_FILE) || (async () => await isPortListening())();
  return Promise.resolve(proxyWasRunning)
    .then(async (running) => {
      await stopRunningProxy();
      restoreBackup(backupName);
      if (running) {
        await startProxy();
        await waitForHealth();
      }
      return { ok: true, backupName, healthUrl: HEALTH_URL };
    });
}

async function status() {
  const running = await isPortListening();
  let health = false;
  let healthBody = null;
  if (running) {
    try {
      healthBody = await waitForHealth(5000);
      health = true;
    } catch {}
  }

  return {
    installedVersion: readInstalledVersion(),
    running,
    health,
    healthUrl: HEALTH_URL,
    backupCount: fs.existsSync(BACKUPS_ROOT)
      ? fs.readdirSync(BACKUPS_ROOT).filter((entry) => fs.statSync(path.join(BACKUPS_ROOT, entry)).isDirectory()).length
      : 0,
    pidExists: fs.existsSync(PID_FILE),
    healthBody,
  };
}

function printUsage() {
  log('Usage: node scripts/deploy.js <release|validate|stage-config|rollback|status> [options]');
  log('');
  log('Commands:');
  log('  release [--skip-tests] [--json]   Build, package, back up, install, restart, health check');
  log('  validate                          Run tests and build');
  log('  stage-config [file]               Stage config for next release');
  log('  rollback <backup-name>            Restore a backup and restart');
  log('  status [--json]                   Show installed version and health');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {
    json: rest.includes('--json'),
    skipTests: rest.includes('--skip-tests'),
    dryRun: rest.includes('--dry-run'),
  };
  const positional = rest.filter((arg) => !arg.startsWith('--'));
  return { command, flags, positional };
}

async function main() {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));
  if (!command || command === '-h' || command === '--help') {
    printUsage();
    return;
  }

  if (flags.dryRun && command !== 'release') {
    fail('--dry-run is only supported with release');
  }

  switch (command) {
    case 'validate':
      validate();
      if (flags.json) console.log(JSON.stringify({ ok: true }, null, 2));
      else log('Validation passed.');
      return;
    case 'stage-config': {
      const staged = stageConfig(positional[0]);
      if (flags.json) console.log(JSON.stringify({ ok: true, staged }, null, 2));
      else log(`Staged config: ${staged}`);
      return;
    }
    case 'release': {
      if (flags.dryRun) {
        const artifact = packArtifact();
        fs.rmSync(artifact, { force: true });
        const info = {
          ok: true,
          dryRun: true,
          wouldValidate: !flags.skipTests,
          artifactPreview: path.basename(artifact),
          healthUrl: HEALTH_URL,
        };
        if (flags.json) console.log(JSON.stringify(info, null, 2));
        else log(`Dry run OK: ${artifact}`);
        return;
      }
      const result = await release({ skipTests: flags.skipTests });
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        log('Release successful.');
        log(`Backup: ${result.backup}`);
        log(`Artifact: ${result.artifact}`);
        log(`Version: ${result.version || 'unknown'}`);
      }
      return;
    }
    case 'rollback': {
      const result = await rollback(positional[0]);
      if (!result.ok) {
        if (flags.json) console.log(JSON.stringify(result, null, 2));
        else {
          log('Available backups:');
          for (const entry of result.backups) log(`  ${entry}`);
        }
        process.exit(1);
      }
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else log(`Rolled back to ${result.backupName}.`);
      return;
    }
    case 'status': {
      const result = await status();
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        log(`Installed version: ${result.installedVersion || 'unknown'}`);
        log(`Running: ${result.running ? 'yes' : 'no'}`);
        log(`Healthy: ${result.health ? 'yes' : 'no'}`);
        log(`Health URL: ${result.healthUrl}`);
        log(`Backups: ${result.backupCount}`);
      }
      return;
    }
    default:
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
