// server-backup.ts
import { execFileSync, execSync, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import readline from "readline";

// =======================
// Config
// =======================
const JAVA_EXE =
    process.env.JAVA_EXE ??
    "C:\\Program Files\\Java\\graalvm-jdk-21.0.8+12.1\\bin\\java.exe";

const JVM_ARGS_FILE = process.env.JVM_ARGS_FILE ?? "@user_jvm_args.txt";
const MC_ARGS_FILE =
    process.env.MC_ARGS_FILE ??
    "@libraries/net/neoforged/neoforge/21.1.209/win_args.txt";
const BACKUP_INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS ?? 1000 * 60 * 30);
const READY_REGEX =
    /\[.*\/INFO] \[minecraft\/DedicatedServer]: Done \(([\d.]+)s\)!/;

// =======================
// State
// =======================
let server: ChildProcessWithoutNullStreams | null = null;
let isServerReady = false;
let backupInProgress = false;
let gitReady = false;

// =======================
// Utility
// =======================
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

/** Gitコマンドを実行してログを詳細出力 */
function runGit(args: string[]) {
    log(`→ git ${args.join(" ")}`);
    try {
        const output = execFileSync("git", args, { encoding: "utf8" });
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
        execSync('git rev-parse --abbrev-ref --symbolic-full-name "@{u}"', {
            stdio: "ignore",
        });
        return true;
    } catch {
        return false;
    }
}

// =======================
// Backup routine
// =======================
async function backup() {
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

    backupInProgress = true;
    try {
        server?.stdin.write(
            `tellraw @a {"text":"サーバーをバックアップしています...","color":"green"}\n`
        );
        server?.stdin.write("save-all flush\n");

        runGit(["add", "-A"]);

        const message = jaTimestamp();
        runGit(["commit", "-m", message]);

        runGit(["push"]);

        server?.stdin.write(
            `tellraw @a {"text":"サーバーのバックアップが完了しました！","color":"green"}\n`
        );
        log("バックアップ完了");
    } catch (e) {
        warn("バックアップ処理中にエラー:", e);
        server?.stdin.write(
            `tellraw @a {"text":"バックアップで問題が発生しました（ログ参照）","color":"red"}\n`
        );
    } finally {
        backupInProgress = false;
    }
}

// =======================
// Server lifecycle
// =======================
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
    });

    server.stderr.on("data", (buf) => process.stderr.write(buf.toString()));

    server.once("exit", (code, signal) => {
        warn(`サーバープロセス終了 code=${code} signal=${signal ?? ""}`);
        process.exit(code ?? 0);
    });

    const shutdown = () => {
        warn("停止シグナル受信、サーバー停止を試みます…");
        try {
            server?.stdin.write("stop\n");
        } catch { }
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}

// =======================
// CLI
// =======================
function setupCLI() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.on("line", (line) => {
        const cmd = line.trim();
        if (cmd === "backup") {
            void backup();
            return;
        }
        server?.stdin.write(cmd + "\n");
    });

    log('コマンド待機中："backup" で即時バックアップ実行');
}

// =======================
// Main
// =======================
(function main() {
    gitReady = checkGitInitialized();
    if (!gitReady) {
        err(
            "gitが初期化されていないか、リモート/上流ブランチが未設定です。\n例：`git init` / `git remote add origin ...` / `git push -u origin <branch>`"
        );
        process.exit(1);
    }

    startServer();
    setupCLI();

    log(`自動バックアップを開始：${Math.round(BACKUP_INTERVAL_MS / 60000)}分毎`);
    setInterval(() => void backup(), BACKUP_INTERVAL_MS);
    void backup();
})();
