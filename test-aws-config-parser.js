const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Parse AWS config file to extract SSO profiles
 * @returns {Object} Object with profile names as keys and profile configs as values
 */
async function parseAwsConfig() {
  try {
    const configPath = path.join(os.homedir(), ".aws", "config");

    if (!fs.existsSync(configPath)) {
      console.log("AWS config file not found at:", configPath);
      return {};
    }

    console.log("Reading AWS config file from:", configPath);
    const configContent = fs.readFileSync(configPath, "utf8");
    const lines = configContent.split("\n");

    const sections = {};
    let currentSection = null;
    let currentSectionType = null;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines and comments
      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }

      // Check for section definitions
      const profileMatch = trimmedLine.match(/^\[profile\s+(.+)\]$/);
      const ssoSessionMatch = trimmedLine.match(/^\[sso-session\s+(.+)\]$/);
      const genericSectionMatch = trimmedLine.match(/^\[(.+)\]$/);

      if (profileMatch) {
        currentSection = profileMatch[1];
        currentSectionType = "profile";
        sections[`profile ${currentSection}`] = {};
        continue;
      } else if (ssoSessionMatch) {
        currentSection = ssoSessionMatch[1];
        currentSectionType = "sso-session";
        sections[`sso-session ${currentSection}`] = {};
        continue;
      } else if (genericSectionMatch && !profileMatch && !ssoSessionMatch) {
        currentSection = genericSectionMatch[1];
        currentSectionType = "other";
        sections[currentSection] = {};
        continue;
      }

      // If we're in a section, parse the key-value pairs
      if (currentSection) {
        const kvMatch = trimmedLine.match(/^(\S+)\s*=\s*(.+)$/);
        if (kvMatch) {
          const [, key, value] = kvMatch;
          sections[`${currentSectionType === "profile" ? "profile " : currentSectionType === "sso-session" ? "sso-session " : ""}${currentSection}`][key] = value;
        }
      }
    }

    console.log("Parsed sections:", Object.keys(sections));

    // Process profiles to handle both direct SSO config and sso-session references
    const ssoProfiles = {};
    
    for (const [sectionName, config] of Object.entries(sections)) {
      // Only process profile sections
      if (!sectionName.startsWith("profile ")) {
        continue;
      }
      
      const profileName = sectionName.substring("profile ".length);
      
      // Case 1: Profile has direct SSO configuration
      if (
        config.sso_start_url &&
        config.sso_region &&
        config.sso_account_id &&
        config.sso_role_name
      ) {
        ssoProfiles[profileName] = {
          name: profileName,
          startUrl: config.sso_start_url,
          region: config.sso_region,
          accountId: config.sso_account_id,
          roleName: config.sso_role_name,
        };
      }
      // Case 2: Profile references an sso-session and has account_id and role_name
      else if (
        config.sso_session &&
        config.sso_account_id &&
        config.sso_role_name
      ) {
        const ssoSessionName = config.sso_session;
        const ssoSessionConfig = sections[`sso-session ${ssoSessionName}`];
        
        if (ssoSessionConfig && ssoSessionConfig.sso_start_url && ssoSessionConfig.sso_region) {
          ssoProfiles[profileName] = {
            name: profileName,
            startUrl: ssoSessionConfig.sso_start_url,
            region: ssoSessionConfig.sso_region,
            accountId: config.sso_account_id,
            roleName: config.sso_role_name,
          };
        }
      }
      // Case 3: Profile references another profile via source_profile
      else if (config.source_profile && config.role_arn) {
        const sourceProfileName = config.source_profile;
        // Check if the source profile is an SSO profile we've already processed
        if (ssoProfiles[sourceProfileName]) {
          // We don't add this profile to ssoProfiles as it's not directly an SSO profile
          // but we could handle it differently if needed
        }
      }
    }
    
    console.log("SSO Profiles:", JSON.stringify(ssoProfiles, null, 2));

    return ssoProfiles;
  } catch (error) {
    console.error("Error parsing AWS config:", error);
    return {};
  }
}

// Run the test
parseAwsConfig().then((profiles) => {
  console.log("\n--- Test Results ---");
  
  // Check if the gen-ai-login profile was correctly parsed
  if (profiles['gen-ai-login']) {
    console.log("✅ Successfully parsed gen-ai-login profile");
    console.log("Profile details:", profiles['gen-ai-login']);
  } else {
    console.log("❌ Failed to parse gen-ai-login profile");
  }
  
  // Check if the gen-ai profile was correctly parsed (if it should be included)
  if (profiles['gen-ai']) {
    console.log("✅ Successfully parsed gen-ai profile");
    console.log("Profile details:", profiles['gen-ai']);
  } else {
    console.log("ℹ️ gen-ai profile not included (expected if it's not an SSO profile)");
  }
  
  console.log("Test completed");
});
