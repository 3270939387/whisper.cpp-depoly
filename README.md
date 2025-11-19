# Whisper 服务完整部署指南

本文档详细说明如何从零开始部署 Whisper 语音识别服务，从克隆 whisper.cpp 到在生产服务器上运行 Node.js API 服务的完整流程。

## 📋 目录

- [系统要求](#系统要求)
- [本地部署（开发环境）](#本地部署开发环境)
- [服务器部署（生产环境）](#服务器部署生产环境)
- [配置说明](#配置说明)
- [服务管理](#服务管理)
- [测试验证](#测试验证)
- [故障排除](#故障排除)

---

## 系统要求

### 必需依赖

- **Git**: 用于克隆 whisper.cpp 仓库
- **C/C++ 编译器**: 
  - Linux: `gcc`, `g++`
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio 或 MinGW
- **CMake**: 3.10 或更高版本
- **Make**: 用于编译
- **Node.js**: 16.x 或更高版本
- **npm**: 随 Node.js 一起安装
- **FFmpeg**: 用于音频格式转换（必需）

### 可选依赖（性能优化）

- **NVIDIA CUDA**: 如果服务器有 NVIDIA GPU，可以启用 CUDA 加速
- **Metal**: macOS 上的 GPU 加速支持

### 系统资源

- **内存**: 至少 4GB RAM（推荐 8GB+）
- **存储**: 
  - whisper.cpp 源码: ~100MB
  - 编译后的二进制文件: ~50MB
  - 模型文件: 
    - `tiny`: ~75MB
    - `base`: ~142MB
    - `small`: ~466MB（推荐）
    - `medium`: ~1.4GB
    - `large`: ~2.9GB
- **CPU**: 多核 CPU 推荐（转录速度更快）

---

## 本地部署（开发环境）

### 步骤 1: 安装系统依赖

#### Linux (Ubuntu/Debian)

```bash
sudo apt-get update
sudo apt-get install -y \
    git \
    build-essential \
    cmake \
    make \
    ffmpeg \
    nodejs \
    npm
```

#### macOS

```bash
# 安装 Homebrew（如果未安装）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 安装依赖
brew install git cmake make ffmpeg node
```

#### 验证安装

```bash
git --version
cmake --version
make --version
ffmpeg -version
node --version
npm --version
```

### 步骤 2: 克隆并编译 whisper.cpp

#### 方法 A: 使用自动化脚本（推荐）

```bash
# 在项目根目录执行
cd /home/alex/2/Globiz

# 运行自动设置脚本（默认使用 small 模型）
bash scripts/setup-whisper.sh small

# 或者指定其他模型大小
bash scripts/setup-whisper.sh base    # 更小，更快
bash scripts/setup-whisper.sh medium  # 更大，更准确
```

脚本会自动完成：
- ✅ 检查依赖
- ✅ 克隆 whisper.cpp 仓库
- ✅ 检测 GPU 支持并编译（CUDA/Metal/CPU）
- ✅ 下载指定大小的模型

#### 方法 B: 手动安装

```bash
# 1. 克隆 whisper.cpp 仓库
cd /home/alex/2/Globiz
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp

# 2. 编译 whisper.cpp
# 检测 GPU 并自动选择编译选项
if command -v nvidia-smi &> /dev/null; then
    echo "🎮 检测到 NVIDIA GPU，使用 CUDA 编译..."
    make CUDA=1
elif [[ "$OSTYPE" == "darwin"* ]]; then
    echo "🍎 macOS 系统，使用 Metal 编译..."
    make METAL=1
else
    echo "💻 CPU 模式编译..."
    make
fi

# 3. 下载模型
cd models
bash ./download-ggml-model.sh small
cd ../..
```

### 步骤 3: 验证 whisper.cpp 编译成功

```bash
# 检查编译后的二进制文件
ls -lh whisper.cpp/build/bin/whisper-cli

# 或者如果使用 make 直接编译（在 whisper.cpp 目录下）
ls -lh whisper.cpp/main

# 测试转录（使用示例音频）
cd whisper.cpp
./build/bin/whisper-cli -m models/ggml-small.bin -f samples/jfk.wav
```

如果看到转录结果，说明编译成功！

### 步骤 4: 安装 Node.js 依赖

```bash
# 进入 scripts 目录
cd /home/alex/2/Globiz/scripts

# 安装 Node.js 依赖
npm install
```

这会安装以下依赖：
- `express`: Web 框架
- `multer`: 文件上传处理
- `cors`: 跨域支持

### 步骤 5: 配置环境变量（可选）

创建 `.env` 文件（在项目根目录）：

```bash
cd /home/alex/2/Globiz
cat > .env << EOF
# Whisper 服务配置
WHISPER_PORT=3003
WHISPER_MODEL_SIZE=small

# 如果 whisper-cli 路径不同，可以指定
# WHISPER_PATH=/path/to/whisper-cli
# WHISPER_MODEL_PATH=/path/to/ggml-small.bin
EOF
```

### 步骤 6: 启动服务

```bash
cd /home/alex/2/Globiz/scripts
npm start
```

或者使用开发模式（自动重启）：

```bash
npm run dev
```

看到以下输出表示启动成功：

```
🚀 Whisper API server running on http://localhost:3003
📦 Model: /home/alex/2/Globiz/whisper.cpp/models/ggml-small.bin
📝 Model size: small
```

---

## 服务器部署（生产环境）

### 前置准备

1. **SSH 连接到服务器**
   ```bash
   ssh user@your-server-ip
   ```

2. **确认服务器规格**
   - 检查 CPU 核心数: `nproc`
   - 检查内存: `free -h`
   - 检查磁盘空间: `df -h`
   - 检查 GPU（如果有）: `nvidia-smi`

### 步骤 1: 在服务器上安装依赖

```bash
# 更新系统包
sudo apt-get update

# 安装必需依赖
sudo apt-get install -y \
    git \
    build-essential \
    cmake \
    make \
    ffmpeg \
    curl

# 安装 Node.js（如果未安装）
# 方法 1: 使用 NodeSource 仓库（推荐，获取最新版本）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 方法 2: 使用系统包管理器（可能版本较旧）
# sudo apt-get install -y nodejs npm

# 验证安装
node --version  # 应该 >= 16.x
npm --version
```

### 步骤 2: 克隆项目或上传代码

#### 方法 A: 如果项目在 Git 仓库中

```bash
# 克隆项目
cd /opt  # 或选择其他目录
git clone <your-repo-url> Globiz
cd Globiz
```

#### 方法 B: 如果项目在本地，使用 SCP 上传

```bash
# 在本地机器执行
cd /home/alex/2
tar -czf Globiz.tar.gz Globiz --exclude='node_modules' --exclude='.next' --exclude='whisper.cpp/build'

# 上传到服务器
scp Globiz.tar.gz user@your-server-ip:/opt/

# 在服务器上解压
ssh user@your-server-ip
cd /opt
tar -xzf Globiz.tar.gz
cd Globiz
```

### 步骤 3: 部署 whisper.cpp

```bash
# 在服务器上执行
cd /opt/Globiz  # 或你的项目路径

# 运行自动设置脚本
bash scripts/setup-whisper.sh small

# 等待编译完成（可能需要 10-30 分钟，取决于服务器性能）
```

**注意**: 
- 编译过程可能需要较长时间，请耐心等待
- 如果服务器有 NVIDIA GPU，脚本会自动检测并使用 CUDA 编译
- 编译过程中会占用大量 CPU 和内存资源

### 步骤 4: 安装 Node.js 依赖

```bash
cd /opt/Globiz/scripts
npm install --production  # 生产环境不需要 devDependencies
```

### 步骤 5: 配置环境变量

```bash
cd /opt/Globiz

# 创建 .env 文件
cat > .env << EOF
# Whisper 服务配置
WHISPER_PORT=3003
WHISPER_MODEL_SIZE=small

# 如果部署路径不同，需要指定完整路径
# WHISPER_PATH=/opt/Globiz/whisper.cpp/build/bin/whisper-cli
# WHISPER_MODEL_PATH=/opt/Globiz/whisper.cpp/models/ggml-small.bin
EOF
```

### 步骤 6: 使用 PM2 管理服务（推荐）

PM2 是一个 Node.js 进程管理器，可以保持服务运行，并在崩溃时自动重启。

#### 安装 PM2

```bash
sudo npm install -g pm2
```

#### 创建 PM2 配置文件

```bash
cd /opt/Globiz/scripts

cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'whisper-server',
    script: 'whisper-server.js',
    cwd: '/opt/Globiz/scripts',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      WHISPER_PORT: 3003,
      WHISPER_MODEL_SIZE: 'small'
    },
    error_file: './logs/whisper-error.log',
    out_file: './logs/whisper-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_memory_restart: '2G',
    watch: false
  }]
};
EOF

# 创建日志目录
mkdir -p logs
```

#### 启动服务

```bash
# 启动服务
pm2 start ecosystem.config.js

# 查看服务状态
pm2 status

# 查看日志
pm2 logs whisper-server

# 设置开机自启
pm2 startup
pm2 save
```

### 步骤 7: 配置反向代理（Nginx）

如果需要通过域名访问或需要 HTTPS，可以配置 Nginx 反向代理。

```bash
# 安装 Nginx
sudo apt-get install -y nginx

# 创建 Nginx 配置
sudo nano /etc/nginx/sites-available/whisper
```

添加以下配置：

```nginx
server {
    listen 80;
    server_name your-domain.com;  # 替换为你的域名或 IP

    # 如果需要 HTTPS，取消下面的注释并配置 SSL
    # listen 443 ssl;
    # ssl_certificate /path/to/cert.pem;
    # ssl_certificate_key /path/to/key.pem;

    client_max_body_size 100M;  # 允许上传大文件

    location / {
        proxy_pass http://localhost:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # 增加超时时间（转录可能需要较长时间）
        proxy_connect_timeout 600s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
    }
}
```

启用配置：

```bash
# 创建符号链接
sudo ln -s /etc/nginx/sites-available/whisper /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重启 Nginx
sudo systemctl restart nginx
```

### 步骤 8: 配置防火墙

```bash
# 如果使用 UFW
sudo ufw allow 3003/tcp  # 直接访问
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS

# 如果使用 firewalld
sudo firewall-cmd --permanent --add-port=3003/tcp
sudo firewall-cmd --reload
```

---

## 配置说明

### 环境变量

| 变量名 | 说明 | 默认值 | 示例 |
|--------|------|--------|------|
| `WHISPER_PORT` | 服务监听端口 | `3003` | `3003` |
| `WHISPER_MODEL_SIZE` | 模型大小 | `small` | `tiny`, `base`, `small`, `medium`, `large` |
| `WHISPER_PATH` | whisper-cli 可执行文件路径 | 自动检测 | `/opt/Globiz/whisper.cpp/build/bin/whisper-cli` |
| `WHISPER_MODEL_PATH` | 模型文件路径 | 自动检测 | `/opt/Globiz/whisper.cpp/models/ggml-small.bin` |

### 模型大小选择

| 模型 | 大小 | 速度 | 准确度 | 推荐场景 |
|------|------|------|--------|----------|
| `tiny` | ~75MB | 最快 | 较低 | 快速测试，资源受限环境 |
| `base` | ~142MB | 快 | 中等 | 一般用途，平衡性能和准确度 |
| `small` | ~466MB | 中等 | 较高 | **推荐**，生产环境首选 |
| `medium` | ~1.4GB | 慢 | 高 | 高准确度要求 |
| `large` | ~2.9GB | 最慢 | 最高 | 最高准确度要求 |

### API 端点

#### 健康检查

```bash
GET /health
```

响应：
```json
{
  "status": "ok",
  "model": "whisper-small",
  "modelPath": "/path/to/ggml-small.bin"
}
```

#### 转录音频

```bash
POST /transcribe
Content-Type: multipart/form-data

参数:
- audio: 音频文件（必需）
- language: 语言代码（可选，默认 'auto'）
- translate: 是否翻译为英文（可选，'true' 或 'false'）
```

响应：
```json
{
  "text": "转录的完整文本",
  "segments": [
    {
      "text": "片段文本",
      "start": 0.0,
      "end": 5.5,
      "id": 0
    }
  ],
  "model": "whisper-small",
  "language": "zh"
}
```

---

## 服务管理

### 使用 PM2 管理

```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs whisper-server
pm2 logs whisper-server --lines 100  # 查看最后 100 行

# 重启服务
pm2 restart whisper-server

# 停止服务
pm2 stop whisper-server

# 删除服务
pm2 delete whisper-server

# 监控
pm2 monit
```

### 使用 systemd（替代方案）

创建 systemd 服务文件：

```bash
sudo nano /etc/systemd/system/whisper-server.service
```

内容：

```ini
[Unit]
Description=Whisper API Server
After=network.target

[Service]
Type=simple
User=your-user  # 替换为实际用户
WorkingDirectory=/opt/Globiz/scripts
Environment="NODE_ENV=production"
Environment="WHISPER_PORT=3003"
Environment="WHISPER_MODEL_SIZE=small"
ExecStart=/usr/bin/node whisper-server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable whisper-server
sudo systemctl start whisper-server
sudo systemctl status whisper-server
```

---

## 测试验证

### 1. 健康检查测试

```bash
curl http://localhost:3003/health
```

### 2. 转录测试

```bash
# 准备测试音频文件
# 可以使用 whisper.cpp 自带的示例
curl -X POST http://localhost:3003/transcribe \
  -F "audio=@whisper.cpp/samples/jfk.wav" \
  -F "language=auto"
```

### 3. 使用 Python 测试脚本

```python
import requests

url = "http://localhost:3003/transcribe"

with open("test-audio.wav", "rb") as f:
    files = {"audio": f}
    data = {"language": "auto"}
    response = requests.post(url, files=files, data=data)
    print(response.json())
```

### 4. 性能测试

```bash
# 使用 ab (Apache Bench) 测试并发
ab -n 10 -c 2 -p test-audio.wav -T 'multipart/form-data' \
   http://localhost:3003/transcribe
```

---

## 故障排除

### 问题 1: 编译失败

**症状**: `make` 命令失败

**解决方案**:
```bash
# 检查依赖是否完整
sudo apt-get install -y build-essential cmake

# 清理并重新编译
cd whisper.cpp
make clean
make

# 如果使用 CUDA，确保 CUDA 工具包已安装
nvidia-smi  # 检查 GPU
nvcc --version  # 检查 CUDA
```

### 问题 2: 模型文件未找到

**症状**: `Error: Model file not found`

**解决方案**:
```bash
# 检查模型文件是否存在
ls -lh whisper.cpp/models/ggml-small.bin

# 如果不存在，重新下载
cd whisper.cpp/models
bash ./download-ggml-model.sh small
```

### 问题 3: FFmpeg 未找到

**症状**: `Failed to start FFmpeg`

**解决方案**:
```bash
# 安装 FFmpeg
sudo apt-get install -y ffmpeg

# 验证安装
ffmpeg -version
```

### 问题 4: 端口被占用

**症状**: `Error: listen EADDRINUSE: address already in use :::3003`

**解决方案**:
```bash
# 查找占用端口的进程
lsof -i :3003
# 或
netstat -tulpn | grep 3003

# 杀死进程
kill -9 <PID>

# 或更改端口
export WHISPER_PORT=3004
npm start
```

### 问题 5: 内存不足

**症状**: 服务崩溃，日志显示内存错误

**解决方案**:
```bash
# 使用更小的模型
export WHISPER_MODEL_SIZE=tiny
# 或
export WHISPER_MODEL_SIZE=base

# 在 PM2 中限制内存
pm2 start ecosystem.config.js --max-memory-restart 2G
```

### 问题 6: 转录速度慢

**解决方案**:
- 使用更小的模型（`tiny` 或 `base`）
- 如果服务器有 GPU，确保使用 CUDA 编译
- 减少音频文件大小（压缩或裁剪）
- 增加服务器 CPU 核心数

### 问题 7: 权限错误

**症状**: `Permission denied`

**解决方案**:
```bash
# 确保 whisper-cli 有执行权限
chmod +x whisper.cpp/build/bin/whisper-cli

# 确保上传目录有写权限
chmod 755 scripts/uploads
```

### 问题 8: 服务无法访问

**检查清单**:
1. 服务是否运行: `pm2 status` 或 `systemctl status whisper-server`
2. 防火墙是否开放端口: `sudo ufw status`
3. 服务是否监听正确地址: `netstat -tulpn | grep 3003`
4. 查看日志: `pm2 logs whisper-server`

---

## 性能优化建议

### 1. 使用 GPU 加速

如果有 NVIDIA GPU：

```bash
# 重新编译 whisper.cpp 启用 CUDA
cd whisper.cpp
make clean
make CUDA=1
```

### 2. 调整模型大小

根据需求选择合适的模型：
- 快速响应: `tiny` 或 `base`
- 平衡性能: `small`（推荐）
- 高准确度: `medium` 或 `large`

### 3. 音频预处理

- 使用 16kHz 采样率（Whisper 推荐）
- 单声道音频
- 压缩音频文件大小

### 4. 并发处理

如果需要处理大量请求，可以考虑：
- 使用负载均衡器（Nginx）
- 运行多个服务实例
- 使用消息队列（Redis/RabbitMQ）

---

## 安全建议

1. **不要暴露服务到公网**: 使用 Nginx 反向代理并配置防火墙
2. **启用 HTTPS**: 使用 Let's Encrypt 免费 SSL 证书
3. **限制文件大小**: 在 Nginx 中设置 `client_max_body_size`
4. **添加认证**: 如果需要，可以在 API 中添加 API Key 验证
5. **定期更新**: 保持 whisper.cpp 和 Node.js 依赖更新

---

## 更新和维护

### 更新 whisper.cpp

```bash
cd whisper.cpp
git pull
make clean
make  # 或 make CUDA=1
```

### 更新 Node.js 依赖

```bash
cd scripts
npm update
```

### 清理临时文件

```bash
# 清理上传的临时文件
find scripts/uploads -type f -mtime +1 -delete

# 清理编译缓存
cd whisper.cpp
make clean
```

---

## 联系和支持

如果遇到问题：
1. 查看日志: `pm2 logs whisper-server`
2. 检查 whisper.cpp 官方文档: https://github.com/ggerganov/whisper.cpp
3. 检查项目 Issues

---

## 附录

### 完整部署命令（一键脚本）

```bash
#!/bin/bash
# 快速部署脚本（适用于 Ubuntu/Debian）

set -e

echo "🚀 开始部署 Whisper 服务..."

# 安装依赖
sudo apt-get update
sudo apt-get install -y git build-essential cmake make ffmpeg curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 克隆项目（假设已在项目目录）
# git clone <your-repo> /opt/Globiz
cd /opt/Globiz

# 设置 whisper.cpp
bash scripts/setup-whisper.sh small

# 安装 Node.js 依赖
cd scripts
npm install --production

# 安装 PM2
sudo npm install -g pm2

# 启动服务
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo "✅ 部署完成！"
echo "查看状态: pm2 status"
echo "查看日志: pm2 logs whisper-server"
```

---

**最后更新**: 2024年

