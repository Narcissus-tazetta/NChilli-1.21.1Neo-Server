import fs from "fs/promises";
import path from "path";


const ROOT = "world/stats"
const ext = ".json"

if (!await fs.exists(ROOT)) {
    console.error("Directory not found, because of your dumbness");
}
for (const item of await fs.readdir(ROOT)) {
    if (item.endsWith(ext)) {
        const uuid = item.split(".")[0] as string

        const { name } = await fetch(`https://api.mojang.com/user/profile/${uuid.replaceAll("-", "")}`).then(res => res.json() as Promise<{ name: string }>);

        const newFile = path.join(ROOT, `${offlineUUID(name)}${ext}`);
        if (await fs.exists(newFile)) {
            if ((await fs.stat(newFile)).size == (await fs.stat(path.join(ROOT, item))).size) {
                await fs.rm(path.join(ROOT, item));
                console.log(`Deleted duplicate file for user ${name}`);
                continue;
            } else {
                console.warn(`Conflict detected for user ${name}. Manual resolution required.`);
            }
        }
        await fs.rename(path.join(ROOT, item), path.join(ROOT, `${offlineUUID(name)}${ext}`))

    }
}


import crypto from "crypto";

/**
 * @author ChatGPT
 */
function offlineUUID(username: string) {
    // 1. プレイヤー名に接頭辞をつける
    const input = "OfflinePlayer:" + username;

    // 2. MD5ハッシュを計算
    const md5 = crypto.createHash("md5").update(input, "utf8").digest();

    // 3. UUIDフォーマットに整形
    md5[6] = (md5[6]! & 0x0f) | 0x30; // version 3     souiu command
    md5[8] = (md5[8]! & 0x3f) | 0x80; // variant

    // 4. UUID形式の文字列に変換
    const hex = md5.toString("hex");
    return (
        hex.substring(0, 8) + "-" +
        hex.substring(8, 12) + "-" +
        hex.substring(12, 16) + "-" +
        hex.substring(16, 20) + "-" +
        hex.substring(20)
    );
}