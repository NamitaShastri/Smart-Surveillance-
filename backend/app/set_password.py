"""Set a password for an existing user:  python -m backend.app.set_password you@example.com"""
import getpass
import sys

from sqlalchemy import func

from . import auth, models
from .database import SessionLocal

email = (sys.argv[1] if len(sys.argv) > 1 else input("Email: ")).strip().lower()
db = SessionLocal()
user = db.query(models.User).filter(func.lower(models.User.email) == email).first()
if user is None:
    sys.exit("No user with that email.")
password = getpass.getpass("New password (min 8 characters): ")
if len(password) < 8 or password != getpass.getpass("Repeat password: "):
    sys.exit("Passwords must match and be at least 8 characters.")
user.password_hash = auth.hash_password(password)
db.commit()
print(f"Password set for {user.email}.")