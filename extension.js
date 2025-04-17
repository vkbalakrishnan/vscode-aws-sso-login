const vscode = require('vscode');
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { promisify } = require("util");
const { SSO } = require("@aws-sdk/client-sso");
const { SSOOIDC } = require("@aws-sdk/client-sso-oidc");

const execAsync = promisify(exec);

/**
 * Parse AWS config file to extract SSO profiles
 * @returns {Object} Object with profile names as keys and profile configs as values
 */
async function parseAwsConfig() {
  try {
    const configPath = path.join(os.homedir(), ".aws", "config");

    if (!fs.existsSync(configPath)) {
      return {};
    }

    const configContent = fs.readFileSync(configPath, "utf8");
    const lines = configContent.split("\n");

    const profiles = {};
    let currentProfile = null;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines and comments
      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }

      // Check for profile definition
      const profileMatch = trimmedLine.match(/^\[profile\s+(.+)\]$/);
      if (profileMatch) {
        currentProfile = profileMatch[1];
        profiles[currentProfile] = {};
        continue;
      }

      // If we're in a profile section, parse the key-value pairs
      if (currentProfile) {
        const kvMatch = trimmedLine.match(/^(\S+)\s*=\s*(.+)$/);
        if (kvMatch) {
          const [, key, value] = kvMatch;
          profiles[currentProfile][key] = value;
        }
      }
    }

    // Filter to only include SSO profiles
    const ssoProfiles = {};
    for (const [name, config] of Object.entries(profiles)) {
      if (
        config.sso_start_url &&
        config.sso_region &&
        config.sso_account_id &&
        config.sso_role_name
      ) {
        ssoProfiles[name] = {
          name,
          startUrl: config.sso_start_url,
          region: config.sso_region,
          accountId: config.sso_account_id,
          roleName: config.sso_role_name,
        };
      }
    }

    return ssoProfiles;
  } catch (error) {
    console.error("Error parsing AWS config:", error);
    return {};
  }
}

/**
 * Get all available AWS SSO profiles
 * @returns {Array} Array of profile objects
 */
async function getAwsSsoProfiles() {
  // Get profiles from AWS config file
  const configProfiles = await parseAwsConfig();

  // Get profiles from VS Code settings
  const vscodeProfiles =
    vscode.workspace.getConfiguration("awsSsoLogin").get("profiles") || [];

  // Convert VS Code profiles to the same format as config profiles
  const vscodeProfilesMap = {};
  for (const profile of vscodeProfiles) {
    vscodeProfilesMap[profile.name] = profile;
  }

  // Merge profiles, with config profiles taking precedence
  const mergedProfiles = { ...vscodeProfilesMap, ...configProfiles };

  return Object.values(mergedProfiles);
}

/**
 * Check if SSO token is valid for the given profile
 * @param {Object} profile The SSO profile
 * @returns {Boolean} True if token is valid, false otherwise
 */
async function isSsoTokenValid(profile) {
  try {
    const ssoClient = new SSO({
      region: profile.region,
    });

    // Try to get account list to verify token is valid
    await ssoClient.listAccounts({});
    return true;
  } catch (error) {
    console.log("SSO token validation error:", error.message);
    return false;
  }
}

/**
 * Start AWS SSO login process
 * @param {Object} profile The SSO profile
 * @returns {Promise<Boolean>} True if login successful
 */
async function startSsoLogin(profile) {
  try {
    // Use AWS CLI to start SSO login
    const command = `aws sso login --profile ${profile.name}`;

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Logging in to AWS SSO profile: ${profile.name}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Opening browser for authentication..." });

        try {
          await execAsync(command);
          return true;
        } catch (error) {
          console.error("AWS SSO login error:", error);
          vscode.window.showErrorMessage(
            `AWS SSO login failed: ${error.message}`
          );
          return false;
        }
      }
    );

    return result;
  } catch (error) {
    console.error("Error starting SSO login:", error);
    vscode.window.showErrorMessage(
      `Error starting SSO login: ${error.message}`
    );
    return false;
  }
}

/**
 * Get AWS credentials for the given profile
 * @param {Object} profile The SSO profile
 * @returns {Promise<Object>} The credentials object
 */
async function getAwsCredentials(profile) {
  try {
    const ssoClient = new SSO({
      region: profile.region,
    });

    const response = await ssoClient.getRoleCredentials({
      accountId: profile.accountId,
      roleName: profile.roleName,
    });

    const credentials = response.roleCredentials;

    return {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      expiration: new Date(credentials.expiration),
    };
  } catch (error) {
    console.error("Error getting AWS credentials:", error);
    throw error;
  }
}

/**
 * Update AWS credentials file with the given credentials
 * @param {String} profileName The profile name
 * @param {Object} credentials The credentials object
 */
async function updateAwsCredentialsFile(profileName, credentials) {
  try {
    const credentialsPath = path.join(os.homedir(), ".aws", "credentials");

    // Create directory if it doesn't exist
    const awsDir = path.join(os.homedir(), ".aws");
    if (!fs.existsSync(awsDir)) {
      fs.mkdirSync(awsDir);
    }

    // Read existing credentials file or create empty content
    let content = "";
    if (fs.existsSync(credentialsPath)) {
      content = fs.readFileSync(credentialsPath, "utf8");
    }

    const lines = content.split("\n");
    const newLines = [];

    let inTargetProfile = false;
    let profileFound = false;

    // Process existing content
    for (const line of lines) {
      const trimmedLine = line.trim();

      // Check for profile definition
      const profileMatch = trimmedLine.match(/^\[(.+)\]$/);
      if (profileMatch) {
        // If we were in the target profile, we're now exiting it
        if (inTargetProfile) {
          inTargetProfile = false;
        }

        // Check if this is the target profile
        if (profileMatch[1] === profileName) {
          profileFound = true;
          inTargetProfile = true;

          // Add profile header
          newLines.push(`[${profileName}]`);

          // Add credentials
          newLines.push(`aws_access_key_id = ${credentials.accessKeyId}`);
          newLines.push(
            `aws_secret_access_key = ${credentials.secretAccessKey}`
          );
          newLines.push(`aws_session_token = ${credentials.sessionToken}`);

          // Skip to next line to avoid adding the profile header again
          continue;
        }
      }

      // Skip lines in the target profile
      if (inTargetProfile) {
        // Skip key-value pairs in the target profile
        if (trimmedLine.match(/^\S+\s*=\s*.+$/)) {
          continue;
        }
      }

      // Add all other lines
      newLines.push(line);
    }

    // If profile wasn't found, add it at the end
    if (!profileFound) {
      // Add a blank line if the file doesn't end with one
      if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== "") {
        newLines.push("");
      }

      newLines.push(`[${profileName}]`);
      newLines.push(`aws_access_key_id = ${credentials.accessKeyId}`);
      newLines.push(`aws_secret_access_key = ${credentials.secretAccessKey}`);
      newLines.push(`aws_session_token = ${credentials.sessionToken}`);
    }

    // Write the updated content back to the file
    fs.writeFileSync(credentialsPath, newLines.join("\n"));

    return true;
  } catch (error) {
    console.error("Error updating AWS credentials file:", error);
    throw error;
  }
}

/**
 * Format expiration time in a human-readable format
 * @param {Date} date The expiration date
 * @returns {String} Formatted expiration time
 */
function formatExpirationTime(date) {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  return `${diffHrs}h ${diffMins}m`;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log("AWS SSO Login extension is now active - DEBUG");
  
  // Log all available commands
  vscode.commands.getCommands().then(commands => {
    console.log("Available commands:", commands);
  });

  // Register the test command
  let testDisposable = vscode.commands.registerCommand(
    "awsSsoLogin.test",
    function () {
      console.log("Test command executed");
      vscode.window.showInformationMessage(
        "AWS SSO Login Test Command Executed!"
      );
    }
  );

  context.subscriptions.push(testDisposable);

  // Register a simple command that just shows a message
  let helloDisposable = vscode.commands.registerCommand(
    "awsSsoLogin.hello",
    function () {
      console.log("Hello command executed");
      vscode.window.showInformationMessage(
        "Hello from AWS SSO Login!"
      );
    }
  );

  context.subscriptions.push(helloDisposable);

  // Register the login command
  let loginDisposable = vscode.commands.registerCommand(
    "awsSsoLogin.login",
    async function () {
      console.log("Login command executed");
      try {
        // Get available profiles
        const profiles = await getAwsSsoProfiles();

        if (profiles.length === 0) {
          vscode.window.showErrorMessage(
            "No AWS SSO profiles found. Please configure profiles in ~/.aws/config or VS Code settings."
          );
          return;
        }

        // Show quick pick to select profile
        const profileItems = profiles.map((profile) => ({
          label: profile.name,
          description: `Account: ${profile.accountId}, Role: ${profile.roleName}`,
          profile,
        }));

        const selectedItem = await vscode.window.showQuickPick(profileItems, {
          placeHolder: "Select an AWS SSO profile",
          ignoreFocusOut: true,
        });

        if (!selectedItem) {
          return; // User cancelled
        }

        const profile = selectedItem.profile;

        // Check if token is valid
        const isTokenValid = await isSsoTokenValid(profile);

        // If token is not valid, start SSO login
        if (!isTokenValid) {
          const loginSuccess = await startSsoLogin(profile);
          if (!loginSuccess) {
            return;
          }
        }

        // Get credentials
        const credentials = await getAwsCredentials(profile);

        // Update credentials file
        await updateAwsCredentialsFile(profile.name, credentials);

        // Show success message with expiration time
        const expirationTime = formatExpirationTime(credentials.expiration);
        vscode.window.showInformationMessage(
          `AWS SSO login successful for profile: ${profile.name}. Credentials will expire in ${expirationTime}.`
        );
      } catch (error) {
        console.error("AWS SSO login error:", error);
        vscode.window.showErrorMessage(
          `AWS SSO login failed: ${error.message}`
        );
      }
    }
  );

  context.subscriptions.push(loginDisposable);

  // Show notification that extension is ready
  vscode.window.showInformationMessage(
    'AWS SSO Login extension is ready. Try running the "AWS SSO: Login with Profile" command.'
  );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
