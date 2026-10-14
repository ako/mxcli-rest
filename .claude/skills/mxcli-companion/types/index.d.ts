// A node of `mxcli project-tree` output.
export type TreeNode = {
  label: string
  type: string
  qualifiedName?: string
  // `mxcli describe <type> <qualifiedName>` answers this node.
  describable?: boolean
  children?: TreeNode[]
}

// What the Source part of the pane shows.
export type Source =
  | { state: 'none' }
  | { state: 'loading'; label: string; qn: string }
  | { state: 'shown'; label: string; qn: string; mdl: string }
  | { state: 'failed'; label: string; qn: string; error: string }
  | { state: 'container'; label: string; type: string; children: string[] }
  // A domain model drawn by `mxcli describe --format svg domainmodel <Module>`.
  | { state: 'diagram'; label: string; qn: string; svg: string; children: string[] }
  | { state: 'drawing'; label: string; qn: string }

// Where the tree came from and how loading it went.
export type Project =
  | { state: 'unlocated' }
  | { state: 'none' }
  | { state: 'choose'; candidates: string[] }
  | { state: 'loading'; mpr: string }
  | { state: 'loaded'; mpr: string; tree: TreeNode[]; loadedMs: number; tookMs: number }
  | { state: 'failed'; mpr: string; error: string }

declare module 'claude-code' {
  interface PluginState {
    'mxcli-companion': {
      project: Project
      expanded: string[]
      selected: string
      source: Source
      treeTop: number
      sourceTop: number
      welcome: boolean
      diagram: { zoom: 'fit' | 'actual'; x: number }
      treeHidden: boolean
    }
  }
}
