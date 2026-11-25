param(
    [Parameter(Mandatory)] [string] $ReferenceRoot,
    [ValidateSet('net8.0', 'net9.0')] [string] $Framework = 'net9.0'
)

$ErrorActionPreference = 'Stop'
$projects = 'LLMContextLib', 'LLMContextLib.Lucene', 'LLMContextLib.BitFaster'
$flags = [Reflection.BindingFlags]'Public, Instance, Static, DeclaredOnly'

function Get-Parameter([Reflection.ParameterInfo] $Parameter) {
    $result = [ordered]@{
        name = $Parameter.Name
        type = $Parameter.ParameterType.ToString()
        optional = $Parameter.IsOptional
    }
    if ($Parameter.HasDefaultValue) {
        $result.default = if ($null -eq $Parameter.DefaultValue) { $null } else { $Parameter.DefaultValue.ToString() }
    }
    return $result
}

$assemblies = foreach ($project in $projects) {
    $file = Join-Path $ReferenceRoot "src\$project\bin\Release\$Framework\$project.dll"
    [Reflection.Assembly]::LoadFrom((Resolve-Path -LiteralPath $file).Path)
}

$inventory = foreach ($assembly in $assemblies) {
    foreach ($type in ($assembly.GetExportedTypes() | Sort-Object FullName)) {
        $members = foreach ($member in ($type.GetMembers($flags) | Sort-Object { $_.ToString() })) {
            # Properties and events already describe the corresponding accessor methods.
            if ($member -is [Reflection.MethodInfo] -and $member.IsSpecialName -and
                $member.Name -match '^(get|set|add|remove)_') { continue }
            if ($member -is [Reflection.FieldInfo] -and $member.Name -eq 'value__' -and $type.IsEnum) { continue }
            $item = [ordered]@{ kind = $member.MemberType.ToString(); signature = $member.ToString() }
            if ($member -is [Reflection.MethodBase]) {
                $item.parameters = @($member.GetParameters() | ForEach-Object { Get-Parameter $_ })
                $item.static = $member.IsStatic
                if ($member.IsDefined([Runtime.CompilerServices.ExtensionAttribute], $false)) { $item.extension = $true }
            } elseif ($member -is [Reflection.PropertyInfo]) {
                $item.readable = $null -ne $member.GetGetMethod()
                $item.writable = $null -ne $member.GetSetMethod()
            } elseif ($member -is [Reflection.FieldInfo] -and $member.IsLiteral) {
                $item.value = $member.GetRawConstantValue()
            }
            $item
        }
        [ordered]@{ assembly = $assembly.GetName().Name; type = $type.FullName; isEnum = $type.IsEnum; members = @($members) }
    }
}

ConvertTo-Json -InputObject @($inventory) -Depth 10
