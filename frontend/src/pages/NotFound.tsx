import { Link } from 'react-router-dom'
import { Button } from '../components/ui'

export default function NotFound() {
  return (
    <div className="text-center py-24 flex flex-col items-center gap-4">
      <span className="font-label text-label-md text-on-surface-variant uppercase tracking-widest">404</span>
      <h1 className="font-headline text-headline-lg text-primary">Page not found</h1>
      <Link to="/">
        <Button variant="outline">Back to Landing</Button>
      </Link>
    </div>
  )
}
