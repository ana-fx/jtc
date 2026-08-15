# JTC — Discord Voice Room Bot

Bot Discord yang otomatis membuat **voice room** untuk user. Dua cara pakai:

1. **Join to Create** — user cukup masuk ke satu voice channel "lobby", bot langsung membuatkan room baru dan memindahkannya ke sana. Room otomatis **terhapus saat kosong**.
2. **Slash command `/voice`** — user yang sedang di voice channel bisa membuat room pribadi kapan saja.
3. **Slash command `/setlimit <count>`** — admin (punya izin *Manage Channels*) mengatur batas maksimal orang yang bisa join tiap room baru. `0` = tanpa batas, maks `99`. Nilainya disimpan di `config.json` dan tetap berlaku setelah bot di-restart.

---

## 1. Persiapan

Butuh **Node.js versi 18 atau lebih baru**. Cek dengan:

```bash
node --version
```

Install dependency:

```bash
npm install
```

## 2. Buat Bot di Discord

1. Buka https://discord.com/developers/applications → **New Application**.
2. Menu **Bot** → **Reset Token** → salin token → tempel ke `DISCORD_TOKEN` di file `.env`.
3. Di halaman **Bot**, aktifkan intent **SERVER MEMBERS INTENT** dan **PRESENCE** tidak wajib, tapi biarkan default; yang penting bot pakai *Voice States* (sudah otomatis).
4. Menu **OAuth2 → URL Generator**: centang scope **`bot`** dan **`applications.commands`**, lalu di **Bot Permissions** centang:
   - Manage Channels
   - Move Members
   - Connect
   - View Channels
5. Buka URL yang dihasilkan untuk **invite bot** ke server kamu.

## 3. Isi Konfigurasi

Salin template lalu isi nilainya:

```bash
cp .env.example .env
```

Isi `.env`:

| Variabel | Cara dapat |
|---|---|
| `DISCORD_TOKEN` | Dari halaman Bot (langkah 2) |
| `CLIENT_ID` | General Information → Application ID |
| `GUILD_ID` | Klik kanan nama server → Copy Server ID |
| `JOIN_TO_CREATE_CHANNEL_ID` | Buat 1 voice channel bernama misal "➕ Buat Room", klik kanan → Copy Channel ID |
| `CATEGORY_ID` | (opsional) kategori tempat room baru dibuat |

> Untuk bisa "Copy ... ID", aktifkan **Developer Mode** di Discord: Settings → Advanced → Developer Mode.

## 4. Daftarkan Slash Command

```bash
npm run deploy
```

## 5. Jalankan Bot

```bash
npm start
```

Kalau muncul `✅ Bot login sebagai ...`, bot sudah aktif. Coba masuk ke channel lobby, atau ketik `/voice` di server.

---

## Cara Kerja Singkat

- **`index.js`** — mendengarkan event `voiceStateUpdate`. Saat ada yang masuk lobby, bot membuat channel baru dan memindahkannya. Saat channel buatan bot kosong, channel dihapus.
- Room yang dibuat bot dilacak selama bot berjalan. **Kalau bot di-restart**, room lama tidak lagi dilacak (tidak akan dihapus otomatis). Untuk pelacakan permanen, perlu disimpan ke database (bisa ditambahkan nanti).

## Troubleshooting

- **Bot online tapi tidak bikin room** → cek `JOIN_TO_CREATE_CHANNEL_ID` benar, dan bot punya permission *Manage Channels* + *Move Members* di kategori tersebut.
- **`/voice` tidak muncul** → jalankan `npm run deploy` lagi, dan pastikan bot di-invite dengan scope `applications.commands`.
- **Error `Used disallowed intents`** → cek pengaturan intent di Developer Portal.
