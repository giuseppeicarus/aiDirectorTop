import { Routes, Route, Navigate } from 'react-router-dom'
import StartupGate from './components/StartupGate'
import Layout from './components/Layout'
import ProjectListScreen from './screens/ProjectListScreen'
import ProjectCreatorScreen from './screens/ProjectCreatorScreen'
import StoryboardScreen from './screens/StoryboardScreen'
import PipelineScreen from './screens/PipelineScreen'
import NodesScreen from './screens/NodesScreen'
import ServicesScreen from './screens/ServicesScreen'
import MediaLibraryScreen from './screens/MediaLibraryScreen'
import SettingsScreen from './screens/SettingsScreen'
import FrameCutOptimizerScreen from './screens/FrameCutOptimizerScreen'
import ProjectDetailScreen from './screens/ProjectDetailScreen'
import QueueScreen from './screens/QueueScreen'
import WorkflowsScreen from './screens/WorkflowsScreen'
import CopilotScreen from './screens/CopilotScreen'
import ToolsScreen from './screens/ToolsScreen'
import ModelsScreen from './screens/ModelsScreen'
import DirectorCinemaScreen from './screens/DirectorCinemaScreen'
import TrailerScreen from './screens/TrailerScreen'
import CreateReelScreen from './screens/CreateReelScreen'
import ObsidianScreen from './screens/ObsidianScreen'
import DashboardScreen from './screens/DashboardScreen'

/** Nessun hook custom qui — evita warning HMR sull'ordine degli hook. */
export default function App() {
  return (
    <StartupGate>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard"               element={<DashboardScreen />} />
          <Route path="projects"                element={<ProjectListScreen />} />
          <Route path="projects/:id"            element={<ProjectDetailScreen />} />
          <Route path="projects/new"            element={<ProjectCreatorScreen />} />
          <Route path="projects/:id/storyboard" element={<StoryboardScreen />} />
          <Route path="projects/:id/pipeline"   element={<PipelineScreen />} />
          <Route path="projects/:id/copilot"   element={<CopilotScreen />} />
          <Route path="projects/:id/trailer"    element={<TrailerScreen />} />
          <Route path="nodes"                   element={<NodesScreen />} />
          <Route path="services"                element={<ServicesScreen />} />
          <Route path="media"                   element={<MediaLibraryScreen />} />
          <Route path="frame-cut-optimizer"     element={<FrameCutOptimizerScreen />} />
          <Route path="queue"                   element={<QueueScreen />} />
          <Route path="workflows"               element={<WorkflowsScreen />} />
          <Route path="tools"                   element={<ToolsScreen />} />
          <Route path="models"                  element={<ModelsScreen />} />
          <Route path="director"                element={<DirectorCinemaScreen />} />
          <Route path="trailer"                 element={<TrailerScreen />} />
          <Route path="createreel"              element={<CreateReelScreen />} />
          <Route path="projects/:id/reel"       element={<CreateReelScreen />} />
          <Route path="obsidian"               element={<ObsidianScreen />} />
          <Route path="settings"               element={<SettingsScreen />} />
        </Route>
      </Routes>
    </StartupGate>
  )
}
