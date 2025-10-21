import { execFileSync, execSync, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { stat, readdir } from "fs/promises";
import { join } from "path";
import readline from "readline";

const JAVA_EXE =
    process.env.JAVA_EXE ??
    "C:\\Program Files\\Java\\graalvm-jdk-21.0.8+12.1\\bin\\java.exe";

const JVM_ARGS_FILE = process.env.JVM_ARGS_FILE ?? "@user_jvm_args.txt";
const MC_ARGS_FILE =
    process.env.MC_ARGS_FILE ??
    "@libraries/net/neoforged/neoforge/21.1.209/win_args.txt";
const BACKUP_INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS ?? 1000 * 60 * 30);
const IDLE_STABLE_SEC = Number(process.env.IDLE_STABLE_SEC ?? 10);
const MAX_WAIT_FOR_IDLE_SEC = Number(process.env.MAX_WAIT_FOR_IDLE_SEC ?? 300);
const SHUTDOWN_WAIT_SEC = Number(process.env.SHUTDOWN_WAIT_SEC ?? 30);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 1000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 3);
const INDEX_LOCK_STALE_MS = Number(process.env.INDEX_LOCK_STALE_MS ?? 60000);

const READY_REGEX = /\[.*\/INFO] \[minecraft\/DedicatedServer]: Done \(([\d.]+)s\)!/;
const JOIN_REGEX = /\[minecraft\/PlayerList]: .+ joined the game/;
const LEAVE_REGEX = /\[minecraft\/MinecraftServer]: .+ left the game/;
const DISCONNECT_REGEX = /lost connection: Disconnected/;

const WATCH_PATHS = ["world/level.dat", "world/data/random_sequences.dat"];

let server: ChildProcessWithoutNullStreams | null = null;
let isServerReady = false;
let backupInProgress = false;
let gitReady = false;
let playerCount = 0;
let lastBackupSuccess = Date.now();

function log(...args: unknown[]) {
    console.log("[runner]", ...args);
}
function warn(...args: unknown[]) {
    console.warn("[runner:warn]", ...args);
}
function err(...args: unknown[]) {
    console.error("[runner:err]", ...args);
}

function jaTimestamp() {
    return new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(new Date());
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getFileSnapshot(paths: string[]): Promise<Map<string, { size: number; mtime: number }>> {
    const snapshot = new Map<string, { size: number; mtime: number }>();
    for (const p of paths) {
        try {
            const s = await stat(p);
            snapshot.set(p, { size: s.size, mtime: s.mtimeMs });
        } catch {
            snapshot.set(p, { size: -1, mtime: -1 });
        }
    }
    try {
        const regionPath = "world/region";
        const files = await readdir(regionPath);
        let maxMtime = 0;
        for (const file of files) {
            if (!file.endsWith(".mca")) continue;
            try {
                const s = await stat(join(regionPath, file));
                if (s.mtimeMs > maxMtime) maxMtime = s.mtimeMs;
            } catch { }
        }
        snapshot.set("__region_max_mtime__", { size: 0, mtime: maxMtime });
    } catch { }
    return snapshot;
}

function snapshotsEqual(a: Map<string, { size: number; mtime: number }>, b: Map<string, { size: number; mtime: number }>): boolean {
    if (a.size !== b.size) return false;
    for (const [key, val] of a) {
        const bVal = b.get(key);
        if (!bVal || bVal.size !== val.size || bVal.mtime !== val.mtime) return false;
    }
    return true;
}

async function waitForStability(maxWaitMs: number, stableMs: number): Promise<boolean> {
    const start = Date.now();
    let lastSnapshot = await getFileSnapshot(WATCH_PATHS);
    let stableSince = Date.now();

    while (Date.now() - start < maxWaitMs) {
        await sleep(POLL_INTERVAL_MS);
        if (playerCount > 0) {
            stableSince = Date.now();
            lastSnapshot = await getFileSnapshot(WATCH_PATHS);
            continue;
        }
        const cur = await getFileSnapshot(WATCH_PATHS);
        if (snapshotsEqual(cur, lastSnapshot)) {
            if (Date.now() - stableSince >= stableMs) {
                log(`安定検知: ${Math.round((Date.now() - stableSince) / 1000)}秒`);
                return true;
            }
        } else {
            lastSnapshot = cur;
            stableSince = Date.now();
        }
    }
    warn(`安定待機タイムアウト: ${Math.round(maxWaitMs / 1000)}秒`);
    return false;
}

function runGit(args: string[]) {
    log(`→ git ${args.join(" ")}`);
    try {
        const output = execFileSync("git", args, { encoding: "utf8", timeout: 120000 });
        if (output.trim()) {
            console.log(output.trim());
        }
        log(`✔ git ${args[0]} 完了`);
    } catch (e: any) {
        const msg = e?.message ?? e;
        err(`✖ git ${args.join(" ")} 失敗: ${msg}`);
        if (e?.stdout) console.log("[stdout]\n" + e.stdout.toString());
        if (e?.stderr) console.error("[stderr]\n" + e.stderr.toString());
        throw e;
    }
}

function checkGitInitialized(): boolean {
    try {
        execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
        execSync("git remote get-url origin", { stdio: "ignore" });
        execSync('git rev-parse --abbrev-ref --symbolic-full-name "@{u}"', { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

async function handleIndexLock(): Promise<void> {
    const lockPath = ".git/index.lock";
    try {
        const lockStat = await stat(lockPath);
        const age = Date.now() - lockStat.mtimeMs;
        if (age > INDEX_LOCK_STALE_MS) {
            warn(`古いindex.lockを検出 (${Math.round(age / 1000)}秒前) - 削除試行`);
            try {
                execSync(`powershell -Command "if (-not (Get-Process git -ErrorAction SilentlyContinue)) { Remove-Item '${lockPath}' -Force }"`);
                log("index.lock削除完了");
            } catch (e) {
                warn("index.lock削除失敗:", e);
            }
        }
    } catch { }
}

async function startupCommit(): Promise<void> {
    log("起動時バックアップ確認...");
    try {
        await handleIndexLock();
        const status = execSync("git status --porcelain", { encoding: "utf8" }).trim();
        if (!status) {
            log("差分なし - スキップ");
            return;
        }
        log("差分検出 - コミット実行");
        runGit(["add", "-A"]);
        runGit(["commit", "-m", `startup ${jaTimestamp()}`]);
        runGit(["push"]);
        log("起動時バックアップ完了");
    } catch (e) {
        warn("起動時バックアップ失敗:", e);
    }
}

async function performGitBackup(): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await handleIndexLock();
            runGit(["add", "-A"]);
            const message = jaTimestamp();
            runGit(["commit", "-m", message]);
            runGit(["push"]);
            return true;
        } catch (e) {
            warn(`Git操作失敗 (試行 ${attempt}/${MAX_RETRIES}):`, e);
            if (attempt < MAX_RETRIES) {
                const backoff = Math.pow(2, attempt) * 1000;
                log(`${backoff}ms 後に再試行`);
                await sleep(backoff);
            }
        }
    }
    return false;
}

async function backup(requirePlayerZero: boolean = true, maxWaitSec?: number) {
    if (!isServerReady) {
        log("サーバー準備中のためバックアップをスキップ");
        return;
    }
    if (!gitReady) {
        warn("Git未準備のためバックアップをスキップ");
        return;
    }
    if (backupInProgress) {
        warn("バックアップ実行中のためスキップ");
        return;
    }
}

function startServer() {
    log("サーバー起動…");

    server = spawn(JAVA_EXE, [JVM_ARGS_FILE, MC_ARGS_FILE, "nogui"], {
        stdio: ["pipe", "pipe", "pipe"],
    });

    server.stdout.on("data", (buf) => {
        const line = buf.toString();
        process.stdout.write(line);

        if (READY_REGEX.test(line)) {
            isServerReady = true;
            log("サーバー準備完了を検知");
        }

        if (JOIN_REGEX.test(line)) {
            playerCount++;
            log(`プレイヤー参加: 現在${playerCount}人`);
        }

        if (LEAVE_REGEX.test(line) || DISCONNECT_REGEX.test(line)) {
            if (playerCount > 0) {
                playerCount--;
                log(`プレイヤー退出: 現在${playerCount}人`);
                if (playerCount === 0) {
                    log("全プレイヤー退出 - バックアップトリガー");
                    void backup(true);
                }
            }
        }
    });

    server.stderr.on("data", (buf) => process.stderr.write(buf.toString()));

    server.once("exit", (code, signal) => {
        warn(`サーバープロセス終了 code=${code} signal=${signal ?? ""}`);
        process.exit(code ?? 0);
    });

    const shutdown = async () => {
        warn("停止シグナル受信 - 最終バックアップを試行");
        try {
            await backup(false, SHUTDOWN_WAIT_SEC);
        } catch (e) {
            err("シャットダウンバックアップ失敗:", e);
        }
        try {
            server?.stdin.write("stop\n");
        } catch { }
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
}

function setupCLI() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.on("line", async (line) => {
        const cmd = line.trim();
        if (cmd === "backup") {
            void backup(false);
            return;
        }
        if (cmd === "status") {
            log(`プレイヤー数: ${playerCount}, 最終成功: ${new Date(lastBackupSuccess).toLocaleString("ja-JP")}`);
            return;
        }
        if (cmd === "stop") {
            try {
                await backup(false, SHUTDOWN_WAIT_SEC);
            } catch (e) {
                warn("stop 時のバックアップでエラー:", e);
            }
            try {
                server?.stdin.write("stop\n");
            } catch { }
            return;
        }
        server?.stdin.write(cmd + "\n");
    });

    log('コマンド待機中："backup" で即時バックアップ, "status" で状態確認');
}

(async function main() {
    gitReady = checkGitInitialized();
    if (!gitReady) {
        err("gitが初期化されていないか、リモート/上流ブランチが未設定です。\n例：`git init` / `git remote add origin ...` / `git push -u origin <branch>`");
        process.exit(1);
    }

    await startupCommit();

    startServer();
    setupCLI();

    log(`自動バックアップを開始：${Math.round(BACKUP_INTERVAL_MS / 60000)}分毎 (idle時のみ実行)`);
    log(`安定判定: ${IDLE_STABLE_SEC}秒, 最大待機: ${MAX_WAIT_FOR_IDLE_SEC}秒`);

    setInterval(() => void backup(true), BACKUP_INTERVAL_MS);
})();
