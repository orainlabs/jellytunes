import { Music, User } from 'lucide-react'
import type { JellyfinUser } from '../appTypes'

interface UserSelectorScreenProps {
  users: JellyfinUser[]
  serverUrl: string
  onSelect: (user: JellyfinUser) => void
  onCancel: () => void
}

export function UserSelectorScreen({ users, serverUrl, onSelect, onCancel }: UserSelectorScreenProps): JSX.Element {
  return (
    <div data-testid="user-selector-screen" className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="w-full max-w-md p-8">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <Music className="w-10 h-10 text-jf-cyan" />
          <h1 className="text-2xl font-bold">Jellysync</h1>
        </div>

        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
          <h2 className="text-lg font-semibold mb-2">Select your user</h2>
          <p className="text-sm text-zinc-400 mb-4">
            Could not automatically identify your account. Please select which Jellyfin user you want to use for sync:
          </p>

          <div className="space-y-2 max-h-64 overflow-y-auto mb-4">
            {users.map((user) => (
              <button
                data-testid="user-option"
                data-user-id={user.Id}
                data-user-name={user.Name}
                key={user.Id}
                onClick={() => onSelect(user)}
                className="w-full flex items-center gap-3 p-3 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors text-left"
              >
                <div className="w-10 h-10 bg-zinc-700 rounded-full flex items-center justify-center">
                  {user.PrimaryImageTag ? (
                    <img
                      src={`${serverUrl}/Users/${user.Id}/Images/Primary?tag=${user.PrimaryImageTag}`}
                      alt={user.Name}
                      className="w-10 h-10 rounded-full object-cover"
                      onError={(e) => {
                        const img = e.target as HTMLImageElement
                        img.style.display = 'none'
                        const parent = img.parentElement
                        if (parent) {
                          const fallback = document.createElement('div')
                          fallback.className = 'w-10 h-10 bg-zinc-600 rounded-full flex items-center justify-center'
                          fallback.innerHTML = '<svg class="w-5 h-5 text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>'
                          parent.appendChild(fallback)
                        }
                      }}
                    />
                  ) : (
                    <User className="w-5 h-5 text-zinc-400" />
                  )}
                </div>
                <div className="flex-1">
                  <div className="font-medium">{user.Name}</div>
                  {user.Policy?.IsAdministrator && (
                    <span className="text-xs text-yellow-500">Administrator</span>
                  )}
                </div>
              </button>
            ))}
          </div>

          <button
            onClick={onCancel}
            className="w-full py-2 rounded-lg font-medium bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
