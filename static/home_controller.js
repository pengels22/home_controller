async function loadStatus() {
    const res = await fetch("/");
    const data = await res.json();
    document.getElementById("status").innerText =
        "Service running • Modules: " + data.modules;
}

async function loadModules() {
    const res = await fetch("/modules");
    const data = await res.json();

    const div = document.getElementById("modules");
    div.innerHTML = "";

    data.forEach(m => {
        const row = document.createElement("div");
        row.innerText =
            `${m.type.toUpperCase()} ${m.address} ${m.name || ""}`;

        const btn = document.createElement("button");
        btn.innerText = "Remove";
        btn.onclick = () => removeModule(m.id);

        row.appendChild(btn);
        div.appendChild(row);
    });
}

async function addModule() {
    const type = document.getElementById("add_type").value;
    const addr = document.getElementById("add_addr").value;
    const name = document.getElementById("add_name").value;

    const res = await fetch("/modules/add", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            type: type,
            address: addr,
            name: name
        })
    });

    const data = await res.json();

    if (!data.ok) {
        alert("Error: " + data.error);
        return;
    }

    loadModules();
}

async function removeModule(id) {
    await fetch("/modules/remove", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({id: id})
    });

    loadModules();
}

loadStatus();
loadModules();
