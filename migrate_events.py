
import sqlite3

connection = sqlite3.connect("smart_surveillance.db")

try:
    columns = {
        row[1]
        for row in connection.execute(
            "PRAGMA table_info(detection_events)"
        )
    }

    if "event_key" not in columns:
        connection.execute(
            "ALTER TABLE detection_events ADD COLUMN event_key TEXT"
        )
        print("Added event_key column.")

    connection.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS
        uq_detection_events_event_key
        ON detection_events(event_key)
    """)

    connection.commit()
    print("Event deduplication migration completed.")

finally:
    connection.close()
