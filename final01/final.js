import supabase from "./auth.js";


document.addEventListener("DOMContentLoaded", function() {
    const btn = document.getElementById("viewFareBtn");
    const popup = document.getElementById("farePopup");
    const closeBtn = document.querySelector(".close-icon");

    if (btn && popup) {
        // Show Popup
        btn.addEventListener("click", function(e) {
            e.preventDefault();
            popup.style.display = "block";
            // Prevent body from scrolling while popup is open
            document.body.style.overflow = "hidden"; 
        });

        // Hide Popup (using the X)
        closeBtn.onclick = function() {
            popup.style.display = "none";
            document.body.style.overflow = "auto";
        };

        // Hide Popup (clicking outside the white box)
        window.onclick = function(event) {
            if (event.target == popup) {
                popup.style.display = "none";
                document.body.style.overflow = "auto";
            }
        };
    }
});



    // 1. Toggle Login/Register inside the wrapper
    const wrapper = document.querySelector('.wrapper');
    const registerLink = document.querySelector('.register-link');
    const loginLink = document.querySelector('.login-link');

    registerLink.onclick = () => { wrapper.classList.add('active'); }
    loginLink.onclick = () => { wrapper.classList.remove('active'); }

    // 2. Password Toggles
    function setupToggle(inputId, toggleId) {
        const passwordField = document.getElementById(inputId);
        const toggleIcon = document.getElementById(toggleId);
        toggleIcon.onclick = function () {
            if (passwordField.type === "password") {
                passwordField.type = "text";
                toggleIcon.classList.replace("bx-hide","bx-show");
            } else {
                passwordField.type = "password";
                toggleIcon.classList.replace("bx-show","bx-hide");
            }
        }
    }
    setupToggle("loginPassword", "toggleLoginPassword");
    setupToggle("registerPassword", "toggleRegisterPassword");

    // 3. Popup Open/Close Control
    const logBtn = document.getElementById("loginBtn");
    const logPopup = document.getElementById("loginPopup");
    const logClose = document.querySelector(".close-login");

    loginBtn.onclick = function(e) {
        e.preventDefault();
        logPopup.style.display = "block";
        document.body.style.overflow = "hidden";
    }

    logClose.onclick = function() {
        logPopup.style.display = "none";
        document.body.style.overflow = "auto";
    }

    window.addEventListener("click", function(event) {
        if (event.target == logPopup) {
            logPopup.style.display = "none";
            document.body.style.overflow = "auto";
        }
    });

    document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("darkToggle");

    // Load saved mode
    if (localStorage.getItem("darkMode") === "enabled") {
        document.body.classList.add("dark-mode");
        toggle.checked = true;
    }

    toggle.addEventListener("change", () => {
        if (toggle.checked) {
            document.body.classList.add("dark-mode");
            localStorage.setItem("darkMode", "enabled");
        } else {
            document.body.classList.remove("dark-mode");
            localStorage.setItem("darkMode", "disabled");
        }
    });
});
// ===== MENU TOGGLE =====
const menuToggle = document.getElementById("menuToggle");
const navGroup = document.getElementById("navGroup");

if (menuToggle && navGroup) {
    menuToggle.addEventListener("click", () => {
        navGroup.classList.toggle("active");

        // change icon ☰ ↔ ✖
        const icon = menuToggle.querySelector("i");
        if (icon) {
            icon.classList.toggle("bx-menu");
            icon.classList.toggle("bx-x");
        }
    });
}



document.addEventListener("DOMContentLoaded", () => {
  const logOut = document.getElementById("LogoutBtn");

  if (logOut) {
    logOut.addEventListener("click", async (e) => {
      e.preventDefault();
      await supabase.auth.signOut();
      window.location.href = "/login";
    });
  }
});


document.addEventListener("DOMContentLoaded", async () => {
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  // Check if user is logged in
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    loginBtn.style.display = "none";
    logoutBtn.style.display = "block";
  } else {
    loginBtn.style.display = "block";
    logoutBtn.style.display = "none";
  }

  // Logout handler
  logoutBtn.addEventListener("click", async () => {
    await supabase.auth.signOut();
    loginBtn.style.display = "block";
    logoutBtn.style.display = "none";
    window.location.href = "/login"; // optional redirect
  });
});

// ===== ROUTE INFO VISIBILITY CONTROL =====
document.addEventListener("DOMContentLoaded", () => {
    const routeInfo = document.getElementById('routeInfo');
    
    // Create an observer to watch for content changes inside the Route Info box
    const observer = new MutationObserver(() => {
        // If the box has content (more than just empty whitespace), show it
        if (routeInfo.innerHTML.trim() !== "") {
            routeInfo.style.display = "block";
        } else {
            routeInfo.style.display = "none";
        }
    });

    if (routeInfo) {
        observer.observe(routeInfo, { childList: true, subtree: true, characterData: true });
    }

    // Optional: Hide the box when the exit/clear button is clicked
    const exitBtn = document.getElementById("exitBtn");
    if (exitBtn) {
        exitBtn.addEventListener("click", () => {
            routeInfo.innerHTML = ""; // This triggers the observer to hide the box
            routeInfo.style.display = "none";
        });
    }
});

