import { exec, execFileSync, execSync, spawn } from "child_process"

if (!checkGitInitialized()) {
    console.error("gitが初期化されていないか、リモートgitリポジトリが設定されていない、またはupstream設定されていません")
    process.exit(1)
}

const server = spawn("C:\\Program Files\\Java\\graalvm-jdk-21.0.8+12.1\\bin\\java.exe", [
    "@user_jvm_args.txt",
    "@libraries/net/neoforged/neoforge/21.1.209/win_args.txt",
    "nogui"
])

// TODO: [21:52:50] [Server thread/INFO] [minecraft/DedicatedServer]: Done (1.815s)! For help, type "help"
// wo kenchi suru

server.on("message", console.log).on("error", console.error)

process.stdin.on("data", (e) => {
    server.stdin.write(e)
})
server.stdout.on("data", (e) => {
    console.log(e.toString())
})
server.stderr.on("data", (e) => console.log(e.toString()))

console.log("Running server...");

backup();
setInterval(backup, 1000 * 60 * 15);

function checkGitInitialized() {
    try {
        execSync("git rev-parse --is-inside-work-tree");
        execSync("git remote get-url origin");
        execSync("git rev-parse --abbrev-ref --symbolic-full-name \"@{u}\"");

        return true
    } catch {
        return false
    }
}

function backup() {
    try {
        server.stdin.write(`tellraw @a {"text":"サーバーをバックアップしています...","color":"green"}`)

        execFileSync("git", ["add", "-A"]);
        execFileSync("git", ["commit", "-m", `"${new Date().toLocaleString("ja-JP", { hour12: false })}"`])
        execFileSync("git push")

        server.stdin.write(`tellraw @a {"text":"サーバーのバックアップが完了しました！","color":"green"}`)
    } catch { }
}