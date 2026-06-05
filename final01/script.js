import supabase from "../supabaseClient.js";
import { loginWithUsername, registerUser } from "./auth.js"
console.log("Supabase client:", supabase)


const { data, error } = await supabase.auth.getSession()

if (data.session) {
console.log("User confirmed and logged in:", data.session.user)
}

const wrapper = document.querySelector('.wrapper');
const registerLink = document.querySelector('.register-link');
const loginLink = document.querySelector('.login-link');

registerLink.addEventListener('click', (e) => {
    e.preventDefault();
    wrapper.classList.add('active');
});

loginLink.addEventListener('click', (e) => {
    e.preventDefault();
    wrapper.classList.remove('active');
});

document.getElementById("LoginForm").addEventListener("submit", async (e) => {
    e.preventDefault()

    const username = document.getElementById("loginUsername").value
    const password = document.getElementById("loginPassword").value

    const user = await loginWithUsername(username, password)

    if (user) {
        alert("Login successful")
        document.querySelector(".wrapper").style.display = "none";
        window.location.href = "final01/index.html";
        } else {
            alert("Invalid username or password.")
        }
})

document.querySelector(".RegisterForm").addEventListener("submit", async (e) => {
    e.preventDefault()

    const username = document.getElementById("registerUsername").value
    const email = document.getElementById("registerEmail").value
    const password = document.getElementById("registerPassword").value

    const user = await registerUser(email, password, username)

    if (user) {
        alert("Registration successful! Check your email for verification.")
    }
})

async function logout() {
  await supabase.auth.signOut();
}

async function getTerminals() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/terminals`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    }
  });

  return await res.json();
}