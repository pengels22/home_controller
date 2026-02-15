from flask import Flask, render_template_string

def create_app():
    app = Flask(__name__)

    @app.route("/")
    def index():
        return render_template_string("""
        <h1>Home Controller</h1>
        <p>Flask app is running.</p>
        """)

    return app

if __name__ == "__main__":
    create_app().run(host="0.0.0.0", port=5000, debug=True)
