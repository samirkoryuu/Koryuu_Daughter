$securePassword = Read-Host "Enter the admin password to hash" -AsSecureString
$pointer = [IntPtr]::Zero
$bytes = $null
$sha256 = $null

try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $bytes = [Text.Encoding]::UTF8.GetBytes($plainPassword)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    $digest = $sha256.ComputeHash($bytes)
    [BitConverter]::ToString($digest).Replace("-", "").ToLowerInvariant()
}
finally {
    if ($bytes) {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    if ($sha256) {
        $sha256.Dispose()
    }
    $plainPassword = $null
    $securePassword.Dispose()
}


