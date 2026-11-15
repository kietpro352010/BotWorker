# KingMC AFK Worker (`BotWorker`)

Ứng dụng AFK Worker thông minh cho KingMC, hỗ trợ chạy tối đa 2 bot slot độc lập trong cùng một tiến trình trên Render hoặc Wispbyte.

---

## 1. Cấu trúc mã nguồn

Toàn bộ mã nguồn nằm hoàn toàn trong thư mục `src/`, tự đóng gói và không phụ thuộc file bên ngoài:

```text
src/
├── index.js                     # Entrypoint khởi động Worker Fleet
├── config/                      # Nạp và kiểm tra biến môi trường
│   ├── env.js                   # Kiểm tra cấu hình slot 1 và slot 2
│   ├── host-runtime.js          # Tự động nhận diện Render / Wispbyte
│   └── proxy.js                 # Bộ phân tích và kiểm tra an toàn SOCKS5 proxy
├── domain/                      # Chuẩn hóa trạng thái
│   └── worker-state.js          # Định nghĩa các trạng thái (online, offline, error, ...)
├── game/                        # Tương tác Minecraft & Mineflayer
│   ├── afk-controller.js        # Điều khiển hành vi giữ kết nối AFK
│   ├── lobby-navigator.js       # Tự động điều hướng và chọn cụm server qua GUI/chat
│   ├── minecraft-session.js     # Quản lý phiên Mineflayer, Auto-Totem và kết nối lại
│   ├── packet-optimization.js   # Giảm tải tài nguyên và tối ưu hóa gói tin
│   ├── server-auth.js           # Xử lý tự động đăng nhập mật khẩu in-game (/login)
│   └── server-monitor.js        # Giám sát ping, TPS và lưu lượng mạng
├── http/                        # Web server nội bộ phục vụ health check và điều khiển
│   ├── app.js                   # Khởi tạo Express app với giới hạn bộ nhớ
│   ├── auth.js                  # Xác thực worker secret bằng timing-safe comparison
│   └── routes.js                # Endpoints /health và /api/v1/bots/:workerId/*
├── services/                    # Dịch vụ quản trị tiến trình worker
│   ├── maintenance-window.js    # Khung giờ bảo trì cố định hàng ngày (04:30 - 05:30 UTC+7)
│   ├── wispbyte-keepalive.js    # Duy trì phiên hoạt động panel Wispbyte
│   ├── worker-fleet.js          # Điều phối 1 hoặc 2 slot bot song song
│   └── worker-runtime.js        # Xếp hàng và tuần tự hóa các lệnh điều khiển
├── transports/                  # Kênh giao tiếp với Manager
│   ├── manager-reporter.js      # Báo cáo heartbeat và sự kiện định kỳ lên Manager
│   └── wispbyte-poller.js       # Long polling nhận lệnh từ Manager (dành cho Wispbyte)
└── utils/                       # Tiện ích bổ trợ
    └── logger.js                # Ghi log có cấu trúc và tự động ẩn dữ liệu nhạy cảm
```

---

## 2. Cấu hình biến môi trường (Environment Variables)

### A. Cấu hình kết nối Manager & Bot Slot (Bắt buộc)

| Tên biến | Bắt buộc | Mô tả |
|---|---|---|
| `MANAGER_URL` | Có | HTTPS URL của dịch vụ Manager (`https://<manager-url>`) |
| `WORKER_ID_1` | Có | ID định danh của Bot Slot 1 được tạo trên Discord Manager (chữ thường, số, gạch ngang) |
| `WORKER_SECRET_1` | Có | Khóa bí mật của Slot 1 (chuỗi ngẫu nhiên từ 32 ký tự trở lên do Manager cấp) |
| `WORKER_ID_2` | Không | ID định danh của Bot Slot 2 (nếu host chạy 2 bot) |
| `WORKER_SECRET_2` | Không | Khóa bí mật của Bot Slot 2 |
| `WORKER_BOT_COUNT` | Không | Số lượng bot chạy trên host này (`1` hoặc `2`). Mặc định tự động bật 2 slot nếu có `WORKER_ID_2` |

> **Lưu ý quan trọng**: Mật khẩu và tài khoản Minecraft được quản lý tập trung và mã hóa an toàn trên Manager, worker nhận thông tin qua HTTPS bootstrap khi khởi động. **Tuyệt đối không điền mật khẩu Minecraft vào biến môi trường của Worker.**

### B. Cấu hình Server Game & Proxy

| Tên biến | Mặc định | Mô tả |
|---|---|---|
| `MC_SERVER_HOSTS` | `sgp.kingmc.vn,kingmc.vn` | Danh sách IP/domain server KingMC được phê duyệt |
| `MC_SERVER_PORT` | `25565` | Cổng kết nối server Minecraft |
| `MC_SERVER_VERSION` | `1.20.1` | Phiên bản giao thức Minecraft |
| `MC_AUTH_TYPE` | `offline` | Kiểu tài khoản Minecraft (`offline` hoặc `microsoft`) |
| `MC_AUTH_ENABLED` | `true` | Tự động trả lời lệnh `/login <mật khẩu>` khi vào server |
| `MC_VIEW_DISTANCE` | `short` | Khoảng cách nhìn (`tiny`, `short`, `normal`, `far`) — chọn `short` để tiết kiệm RAM |
| `MC_PROXY_URL_1` | *(trống)* | URL Proxy SOCKS5 riêng cho slot 1 (ví dụ `socks5://user:pass@host:1080`) |
| `MC_PROXY_URL_2` | *(trống)* | URL Proxy SOCKS5 riêng cho slot 2 |
| `JOIN_COMMAND` | *(trống)* | Lệnh gửi vào game sau khi spawn (ví dụ lệnh vào cụm server) |
| `AUTO_START` | `true` | Tự động kết nối vào server ngay khi khởi động worker |
| `AUTO_RECONNECT` | `true` | Tự động kết nối lại khi bị ngắt kết nối với cơ chế backoff |

---

## 3. Hướng dẫn triển khai (Deployment Guide)

### Cách 1: Triển khai trên Render (Web Service)

1. Tạo mới **Web Service** trên [Render Dashboard](https://dashboard.render.com) kết nối repository này.
2. Cấu hình:
   - **Name**: `kingmc-afk-worker-01`
   - **Region**: `Singapore` (để kết nối server KingMC mượt nhất)
   - **Runtime**: `Node`
   - **Build Command**: `npm ci --omit=dev`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
3. Thêm các biến môi trường: `MANAGER_URL`, `WORKER_ID_1`, `WORKER_SECRET_1` (và slot 2 nếu có).

### Cách 2: Triển khai trên Wispbyte / Pterodactyl (Node.js Bot Hosting)

1. Upload toàn bộ repository này vào file manager của server Wispbyte.
2. Đặt lệnh khởi động: `npm run start:wispbyte`.
3. Thêm các biến môi trường vào file cấu hình `.env` hoặc Startup Variables trên panel.
4. Worker sẽ tự động kết nối long-poll ra ngoài Manager, **không cần mở cổng mạng (port forwarding)** hay cấu hình domain.

---

## 4. Tính năng bảo vệ và tối ưu tự động

- **Auto-Totem siêu tốc**: Tự động phát hiện nổ Totem hoặc máu tụt xuống mức nguy hiểm để lập tức trang bị Totem vào tay phụ với mutex chống kẹt packet.
- **Tiết kiệm tài nguyên**: Giới hạn heap V8 ở mức 384MB, tự động lọc bớt các gói tin đồ họa và âm thanh không cần thiết cho AFK.
- **Khung giờ bảo trì tự động**: Dừng bot an toàn vào lúc `04:30` và tự động kết nối lại lúc `05:30` (giờ Việt Nam, UTC+7) mỗi ngày để đồng bộ với lịch restart của cụm máy chủ KingMC.
