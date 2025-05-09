# AWS SSO Login Extension for VS Code

This VS Code extension allows you to easily log in to AWS SSO with a specific profile directly from VS Code.

## Features

- Log in to AWS SSO with a specific profile
- Select from multiple configured profiles
- Automatically update AWS credentials file with temporary credentials
- Display credential expiration time

## Requirements

- AWS CLI installed and configured
- AWS SSO access configured

## Installation

### From VSIX File

1. Download the `.vsix` file from the releases page
2. Open VS Code
3. Go to Extensions view (Ctrl+Shift+X)
4. Click on the "..." menu in the top-right corner
5. Select "Install from VSIX..."
6. Choose the downloaded `.vsix` file

### Building from Source

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `vsce package` to create a `.vsix` file
4. Follow the steps above to install the `.vsix` file

## Configuration

The extension automatically detects AWS SSO profiles from your AWS CLI configuration file (`~/.aws/config`). No additional configuration is required if you already have AWS SSO profiles configured for the AWS CLI.

### AWS CLI Configuration (Recommended)

If you have AWS CLI installed, you can configure SSO profiles in `~/.aws/config`:

```ini
[profile dev]
sso_start_url = https://your-sso-start-url.awsapps.com/start
sso_region = us-west-2
sso_account_id = 123456789012
sso_role_name = DeveloperAccess

[profile prod]
sso_start_url = https://your-sso-start-url.awsapps.com/start
sso_region = us-west-2
sso_account_id = 987654321098
sso_role_name = ReadOnlyAccess
```

### VS Code Settings (Alternative)

You can also configure profiles directly in VS Code settings:

1. Open VS Code settings (File > Preferences > Settings)
2. Search for "AWS SSO Login"
3. Click "Edit in settings.json"
4. Add your profiles in the following format:

```json
"awsSsoLogin.profiles": [
  {
    "name": "dev",
    "startUrl": "https://your-sso-start-url.awsapps.com/start",
    "region": "us-west-2",
    "accountId": "123456789012",
    "roleName": "DeveloperAccess"
  }
]
```

**Note:** Profiles from `~/.aws/config` take precedence over profiles with the same name in VS Code settings.

## Usage

1. Open the Command Palette (Ctrl+Shift+P)
2. Type "AWS SSO: Login with Profile" and select it
3. Choose a profile from the dropdown list
4. Follow the browser authentication if prompted
5. Once authenticated, your AWS credentials file will be updated with temporary credentials

## How It Works

The extension:
1. Checks for existing valid SSO tokens
2. If no valid token is found, initiates the AWS SSO login flow using the AWS CLI
3. Retrieves role credentials using the SSO token
4. Updates your AWS credentials file with the temporary credentials
5. Shows a notification with the credential expiration time

## CI/CD Process

This project uses GitHub Actions for continuous integration and delivery:

### Workflows

- **Build**: Runs on every push to main and pull requests. Compiles and packages the extension.
- **Lint and Test**: Verifies code quality and runs tests.
- **Release**: Triggered when a tag is pushed. Creates a GitHub release with the packaged extension.
- **Dependency Updates**: Runs weekly to check for dependency updates and creates PRs if needed.
- **CodeQL Analysis**: Performs security analysis on the codebase.
- **Stale Issues**: Automatically manages stale issues and pull requests.

### Development Workflow

1. Create a feature branch from `main`
2. Make your changes
3. Create a pull request to `main`
4. The CI workflows will automatically run to verify your changes
5. After review and approval, merge your PR to `main`

## Release Process

To create a new release of the extension:

1. Update the version number in `package.json`
2. Commit and push your changes to the main branch
3. Create and push a new tag with the version number:
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```
4. The GitHub Actions workflow will automatically:
   - Build the extension
   - Create a GitHub release
   - Attach the VSIX file to the release

To publish to the VS Code Marketplace:
1. Uncomment the publishing step in `.github/workflows/release.yml`
2. Add a repository secret called `VSCE_PAT` with your Visual Studio Marketplace Personal Access Token

## License

MIT
