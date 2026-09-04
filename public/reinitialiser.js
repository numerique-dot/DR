import { $, boot, notify } from "/shared.js";

const token = new URLSearchParams(window.location.search).get("jeton");

$("#reset-missing").hidden = Boolean(token);
$("#reset-form").hidden = !token;

$("#reset-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const box = $("#reset-error");
  box.hidden = true;

  const password = form.elements.password.value;
  if (password !== form.elements.confirm.value) {
    box.textContent = "Les deux mots de passe ne correspondent pas.";
    box.hidden = false;
    return;
  }

  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const response = await fetch("/api/auth/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Changement impossible.");
    // Le lien est consommé : on retire le jeton de la barre d'adresse.
    history.replaceState(null, "", window.location.pathname);
    $("#reset-form").hidden = true;
    $("#reset-done").hidden = false;
    notify("Mot de passe modifié.");
  } catch (error) {
    box.textContent = error.message;
    box.hidden = false;
  } finally {
    button.disabled = false;
  }
});

boot();
