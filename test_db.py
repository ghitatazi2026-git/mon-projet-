import os
import sys

# Force UTF-8 output for Windows terminals to prevent CP1252 print crashes
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

# Load environment variables from .env file with proper encoding handling
def load_env_file():
    """Load .env file with proper encoding handling (UTF-8 first, then Latin-1)."""
    env_path = '.env'
    if not os.path.exists(env_path):
        return
    
    try:
        # Try UTF-8 first
        with open(env_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except UnicodeDecodeError:
        # Fall back to Latin-1 if UTF-8 fails
        with open(env_path, 'r', encoding='latin-1') as f:
            content = f.read()
    
    # Parse the .env content manually
    for line in content.split('\n'):
        line = line.strip()
        if line and not line.startswith('#'):
            if '=' in line:
                key, value = line.split('=', 1)
                os.environ[key.strip()] = value.strip()

load_env_file()

def test_database_connection():
    """
    Tests the PostgreSQL database connection and displays users.
    """
    try:
        # Import psycopg2
        try:
            import psycopg2
        except ImportError:
            print("[ERROR] The 'psycopg2' module is not installed.")
            print("   Please install dependencies with: pip install psycopg2-binary")
            sys.exit(1)

        # Get connection parameters from environment variables
        db_host = os.getenv('DB_HOST', 'localhost')
        db_port = os.getenv('DB_PORT', '5432')
        db_name = os.getenv('DB_NAME', 'monitoring_db')
        db_user = os.getenv('DB_USER', 'dev_admin')
        db_pass = os.getenv('DB_PASS', '')

        # Auto-detect Docker environment: replace localhost/127.0.0.1 with 'db' service name if running inside Docker
        if os.path.exists('/.dockerenv') and db_host in ['localhost', '127.0.0.1']:
            db_host = 'db'

        print("[INFO] Connection parameters loaded from .env:")
        print(f"       - Host: {db_host}")
        print(f"       - Port: {db_port}")
        print(f"       - Database: {db_name}")
        print(f"       - User: {db_user}")
        print()

        # Establish database connection
        print("[INFO] Attempting to connect to the database...")
        connection = psycopg2.connect(
            host=db_host,
            port=db_port,
            database=db_name,
            user=db_user,
            password=db_pass
        )
        print("[SUCCESS] Connection established!")
        print()

        # Create a cursor
        cursor = connection.cursor()

        # Execute SELECT query
        print("[INFO] Executing query: SELECT * FROM users;")
        cursor.execute("SELECT * FROM users;")

        # Fetch all results
        users = cursor.fetchall()
        
        # Get column names
        column_names = [description[0] for description in cursor.description]

        # Display results
        if users:
            print(f"\n[SUCCESS] {len(users)} user(s) found:\n")
            print("-" * 70)
            for idx, user in enumerate(users, 1):
                print(f"User #{idx}:")
                for col_name, col_value in zip(column_names, user):
                    print(f"  {col_name}: {col_value}")
                print("-" * 70)
        else:
            print("\n[WARNING] No users found in the database.")

        # Close cursor and connection
        cursor.close()
        connection.close()
        print("\n[SUCCESS] Connection closed.")

    except psycopg2.OperationalError as e:
        print(f"\n[ERROR] CONNECTION FAILED: Unable to connect to the database.")
        print(f"         Details: {str(e)}")
        print("\n         Please verify:")
        print("         - PostgreSQL server is running")
        print("         - Connection parameters in .env are correct")
        print("         - Username and password are valid")
        sys.exit(1)

    except psycopg2.Error as e:
        print(f"\n[ERROR] DATABASE ERROR: {str(e)}")
        sys.exit(1)

    except Exception as e:
        print(f"\n[ERROR] UNEXPECTED ERROR: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    print("=" * 70)
    print("   DATABASE CONNECTION TEST - PostgreSQL")
    print("=" * 70)
    print()
    test_database_connection()
    