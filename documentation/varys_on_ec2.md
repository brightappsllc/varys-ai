# Varys on EC2 — Getting Started

Run JupyterLab + Varys in your browser while all computation executes on a remote EC2 instance. An SSH tunnel keeps everything encrypted — no open ports needed.

---

## 1. First-Time Setup (EC2)

SSH into your instance, then run:

```bash
# Create a Python environment and install Varys
python3.11 -m venv ~/varys-env
source ~/varys-env/bin/activate
pip install --upgrade pip
pip install jupyterlab
pip install "varys[all] @ git+https://github.com/brightappsllc/varys-ai"
```

Set a login password and configure the server:

```bash
jupyter lab --generate-config      # creates ~/.jupyter/jupyter_lab_config.py
jupyter lab password               # enter and confirm a password
```

Add these lines to `~/.jupyter/jupyter_lab_config.py`:

```python
c.ServerApp.ip = '127.0.0.1'      # tunnel-safe: reachable only via SSH
c.ServerApp.port = 8888
c.ServerApp.open_browser = False
```

Configure your LLM API keys — see [README](../README.md) for details.

### Run as a persistent service (survives disconnections)

```bash
sudo nano /etc/systemd/system/jupyterlab.service
```

```ini
[Unit]
Description=JupyterLab Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu
Environment="PATH=/home/ubuntu/varys-env/bin:/usr/bin:/bin"
ExecStart=/home/ubuntu/varys-env/bin/jupyter lab \
    --config=/home/ubuntu/.jupyter/jupyter_lab_config.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable jupyterlab
sudo systemctl start jupyterlab
```

---

## 2. SSH Tunnel Setup (Local Machine)

Add to `~/.ssh/config` on your laptop:

```
Host varys-ec2
    HostName <EC2_PUBLIC_IP_OR_DNS>
    User ubuntu
    IdentityFile ~/.ssh/your-key.pem
    LocalForward 8888 localhost:8888
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

> Use an [Elastic IP](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html) so the address stays stable across EC2 stop/start cycles.

---

## 3. Daily Workflow

```
1. Start EC2 instance (AWS console or CLI)
2. ssh -N varys-ec2          ← opens the tunnel (keep this terminal open)
3. Open http://localhost:8888 in your browser
4. Work in JupyterLab + Varys
5. Stop the EC2 instance when done (tunnel closes automatically)
```

---

## 4. Useful Commands

```bash
# On EC2 — check service status and live logs
sudo systemctl status jupyterlab
sudo journalctl -u jupyterlab -f

# Restart after a config change
sudo systemctl restart jupyterlab

# Verify Varys loaded correctly
jupyter server extension list | grep varys

# Check GPU
nvidia-smi
```

---

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| `localhost:8888` refused | Confirm tunnel is open; check `systemctl status jupyterlab` on EC2 |
| Password not accepted | Re-run `jupyter lab password` on EC2, then `systemctl restart jupyterlab` |
| Varys panel missing | Run `jupyter server extension list \| grep varys` on EC2 |
| Tunnel drops on idle | Verify `ServerAliveInterval 60` is in `~/.ssh/config` |
| IP changed after restart | Allocate and assign an Elastic IP in the AWS console |
