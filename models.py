from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime
import uuid

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(50), nullable=False, default='viewer') # 'viewer', 'analyst', 'admin_secops'
    full_name = db.Column(db.String(120), nullable=True)
    mfa_secret = db.Column(db.String(64), nullable=True)
    mfa_enabled = db.Column(db.Boolean, default=False)
    failed_login_attempts = db.Column(db.Integer, default=0)
    locked_until = db.Column(db.DateTime, nullable=True)
    last_login = db.Column(db.DateTime, nullable=True)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def to_dict(self):
        return {
            "id": self.id,
            "username": self.username,
            "role": self.role,
            "full_name": self.full_name or self.username,
            "mfa_enabled": self.mfa_enabled,
            "last_login": self.last_login.strftime("%d/%m/%Y %H:%M:%S") if self.last_login else None
        }


class Server(db.Model):
    __tablename__ = 'servers'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), unique=True, nullable=False)
    ip = db.Column(db.String(50), nullable=False)
    ssh_port = db.Column(db.Integer, default=22)
    service_port = db.Column(db.Integer, default=80)
    role = db.Column(db.String(50), default='NODE')
    user = db.Column(db.String(100), default='r2schools')
    key_path = db.Column(db.String(255), nullable=True)

    def to_dict(self):
        return {
            "name": self.name,
            "ip": self.ip,
            "ssh_port": self.ssh_port,
            "service_port": self.service_port,
            "role": self.role,
            "user": self.user,
            "key_path": self.key_path
        }


class Incident(db.Model):
    __tablename__ = 'incidents'
    id = db.Column(db.String(50), primary_key=True, default=lambda: f"#INC-2026-{str(uuid.uuid4())[:4].upper()}")
    service = db.Column(db.String(100), nullable=False)
    status = db.Column(db.String(100), nullable=False)
    action = db.Column(db.String(255), nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    assignee = db.Column(db.String(100), nullable=False)

    def to_dict(self):
        return {
            "id": self.id,
            "service": self.service,
            "status": self.status,
            "action": self.action,
            "timestamp": self.timestamp.strftime("%d/%m/%Y %H:%M:%S"),
            "assignee": self.assignee
        }


class Alert(db.Model):
    __tablename__ = 'alerts'
    id = db.Column(db.String(50), primary_key=True, default=lambda: str(uuid.uuid4()))
    message = db.Column(db.Text, nullable=False)
    status = db.Column(db.String(50), default='Pending') # Pending, Resolved
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "message": self.message,
            "status": self.status,
            "timestamp": self.timestamp.timestamp()
        }
