import { renderSVG } from 'uqr'

export default function RemoteJoinQr({ url }: { url: string }) {
  const svg = renderSVG(url, {
    pixelSize: 4,
    border: 4,
    whiteColor: '#ffffff',
    blackColor: '#111111'
  })
  return (
    <div
      data-testid="settings-remote-qr"
      data-qr-url={url}
      className="inline-block w-[200px] max-w-full overflow-hidden rounded-lg border border-border-default bg-white p-2 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
